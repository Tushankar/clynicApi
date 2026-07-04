'use strict';

const { Clinic, Appointment, Doctor, Patient, Invoice, Prescription } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { verifyToken } = require('../lib/publicLinks');
const { planHasFeature } = require('../config/plans');
const { dayRange, parseDateOnly, dateKey } = require('../lib/datetime');
const { generateSlots } = require('../lib/availability');
const { ACTIVE_STATUSES } = require('../config/appointments');
const availabilityBlockService = require('./availabilityBlockService');
const paymentService = require('./paymentService');
const gateway = require('../lib/payments');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Patient self-service behind tokenized links (§5.20+): manage an appointment
 * (reschedule/cancel), pay an invoice's dues, leave a post-visit review, and view
 * a shared document. NO Clerk auth — authority comes from the HMAC token, which
 * binds {type, clinicId, recordId}; every handler re-checks the record's live state
 * and the clinic's plan entitlement before acting (the link is never the lock).
 */

const MANAGE_LEAD_MINUTES = 120; // patients can self-modify until 2h before the visit
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function linkCtx(clinicId) {
  return { clinicId, actorId: 'patient-link', actorRole: null };
}

async function resolveClinic(clinicId) {
  const clinic = await Clinic.findOne({ clinicId }).lean();
  if (!clinic) throw new AppError(404, 'Link expired or invalid');
  return clinic;
}

function requirePlan(clinic, featureKey) {
  // Public-facing: an unentitled clinic's links simply don't exist (no upsell leak).
  if (!planHasFeature(clinic.subscriptionPlan, featureKey)) throw new AppError(404, 'Link expired or invalid');
}

function clinicView(clinic) {
  return {
    name: clinic.name,
    slug: clinic.slug,
    phone: clinic.phone || '',
    address: clinic.address || '',
    logoUrl: /^https?:\/\//i.test(clinic.logoUrl || '') ? clinic.logoUrl : '',
  };
}

// ---- Manage (reschedule / cancel) ---------------------------------------------------

async function loadManage(token) {
  const payload = verifyToken(token, 'manage');
  if (!payload) throw new AppError(404, 'Link expired or invalid');
  const clinic = await resolveClinic(payload.cid);
  requirePlan(clinic, 'SELF_RESCHEDULE');
  const ctx = linkCtx(clinic.clinicId);
  const appt = await tenantRepo(Appointment, ctx, { audit: false }).findById(payload.id, { lean: true });
  if (!appt) throw new AppError(404, 'Appointment not found');
  return { clinic, appt, ctx };
}

function managePermissions(appt, now = new Date()) {
  const modifiable = ['booked', 'confirmed'].includes(appt.status);
  const beforeCutoff = new Date(appt.scheduledAt).getTime() - MANAGE_LEAD_MINUTES * 60000 > now.getTime();
  return {
    canReschedule: modifiable && beforeCutoff,
    canCancel: modifiable && beforeCutoff,
    leadMinutes: MANAGE_LEAD_MINUTES,
  };
}

function manageAppointmentView(appt) {
  return {
    id: String(appt._id),
    doctorId: String(appt.doctorId),
    doctorName: appt.doctorName || '',
    patientName: appt.patientName || '',
    scheduledAt: appt.scheduledAt,
    durationMinutes: appt.durationMinutes || 15,
    status: appt.status,
    tokenNumber: appt.tokenNumber ?? null,
    reason: appt.reason || '',
    prepaid: !!appt.prepaid,
  };
}

async function manageView(token) {
  const { clinic, appt } = await loadManage(token);
  return {
    clinic: clinicView(clinic),
    appointment: manageAppointmentView(appt),
    permissions: managePermissions(appt),
  };
}

/** Slots for the appointment's own doctor on a date (public lead time + blocks). */
async function manageSlots(token, date) {
  const { appt, ctx } = await loadManage(token);
  const doctor = await tenantRepo(Doctor, ctx, { audit: false }).findById(appt.doctorId);
  if (!doctor || !doctor.isActive) throw new AppError(404, 'Doctor not found');

  const day = date ? parseDateOnly(date) : new Date(appt.scheduledAt);
  const { start, end } = dayRange(day);
  const [booked, blocks] = await Promise.all([
    tenantRepo(Appointment, ctx, { audit: false }).find(
      { doctorId: doctor._id, scheduledAt: { $gte: start, $lte: end }, status: { $in: ACTIVE_STATUSES } },
      { lean: true }
    ),
    availabilityBlockService.blocksFor(ctx, { doctorId: doctor._id, from: start, to: end }),
  ]);
  return {
    date: dateKey(day),
    doctorId: String(doctor._id),
    slots: generateSlots({
      doctor,
      date: day,
      // The patient's own current slot stays selectable (it's theirs to move back to).
      bookedStarts: booked.filter((b) => String(b._id) !== String(appt._id)).map((b) => b.scheduledAt),
      leadMinutes: 30,
      blocks,
    }),
  };
}

async function manageReschedule(token, scheduledAt) {
  const { clinic, appt, ctx } = await loadManage(token);
  const perms = managePermissions(appt);
  if (!perms.canReschedule) throw new AppError(409, 'This appointment can no longer be rescheduled online — please call the clinic.');

  const appointmentService = require('./appointmentService');
  // reschedule() now sends the patient their fresh confirmation (one shared path for staff +
  // patient reschedules), so we no longer double-send it here.
  const updated = await appointmentService.reschedule(ctx, appt._id, scheduledAt);

  return {
    clinic: clinicView(clinic),
    appointment: manageAppointmentView(updated.toObject ? updated.toObject() : updated),
    permissions: managePermissions(updated),
  };
}

async function manageCancel(token, reason) {
  const { clinic, appt, ctx } = await loadManage(token);
  const perms = managePermissions(appt);
  if (!perms.canCancel) throw new AppError(409, 'This appointment can no longer be cancelled online — please call the clinic.');

  const appointmentService = require('./appointmentService');
  const updated = await appointmentService.cancel(ctx, appt._id, String(reason || 'Cancelled by patient via manage link').slice(0, 200));

  return {
    clinic: clinicView(clinic),
    appointment: manageAppointmentView(updated.toObject ? updated.toObject() : updated),
    permissions: managePermissions(updated),
  };
}

// ---- Pay an invoice (payment links) --------------------------------------------------

async function loadPay(token) {
  const payload = verifyToken(token, 'pay');
  if (!payload) throw new AppError(404, 'Link expired or invalid');
  const clinic = await resolveClinic(payload.cid);
  requirePlan(clinic, 'PAYMENT_LINKS');
  const ctx = linkCtx(clinic.clinicId);
  const invoice = await tenantRepo(Invoice, ctx, { audit: false }).findById(payload.id, { lean: true });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  return { clinic, invoice, ctx };
}

function invoiceView(inv) {
  const balance = round2(inv.total - inv.amountPaid);
  return {
    id: String(inv._id),
    invoiceNumber: inv.invoiceNumber,
    patientName: inv.patientName || '',
    items: (inv.items || []).map((it) => ({ description: it.description, amount: it.amount, quantity: it.quantity || 1 })),
    subtotal: inv.subtotal,
    gstRate: inv.gstRate,
    gstAmount: inv.gstAmount,
    total: inv.total,
    amountPaid: inv.amountPaid,
    balance: balance > 0 ? balance : 0,
    status: inv.status,
    createdAt: inv.createdAt,
  };
}

async function payView(token) {
  const { clinic, invoice } = await loadPay(token);
  return { clinic: clinicView(clinic), invoice: invoiceView(invoice) };
}

async function payOrder(token) {
  const { invoice, ctx } = await loadPay(token);
  return paymentService.createInvoiceOrder(ctx, invoice._id); // server-side amount (dues)
}

async function payVerify(token, { orderId, paymentId, signature }) {
  const { ctx } = await loadPay(token);
  const result = await paymentService.verifyPayment(ctx, { orderId, paymentId, signature });
  const { invoice } = await loadPay(token); // fresh totals after credit
  return { ...result, invoice: invoiceView(invoice) };
}

async function payMockSign(token, { orderId, paymentId }) {
  if (config.payments.driver !== 'mock') throw new AppError(404, 'Not found');
  await loadPay(token);
  const pid = paymentId || `pay_mock_${Date.now()}`;
  return { paymentId: pid, signature: gateway.devSignPayment(orderId, pid) };
}

// ---- Post-visit review ---------------------------------------------------------------

async function loadReview(token) {
  const payload = verifyToken(token, 'review');
  if (!payload) throw new AppError(404, 'Link expired or invalid');
  const clinic = await resolveClinic(payload.cid);
  requirePlan(clinic, 'REVIEW_REQUESTS');
  const ctx = linkCtx(clinic.clinicId);
  const appt = await tenantRepo(Appointment, ctx, { audit: false }).findById(payload.id, { lean: true });
  if (!appt) throw new AppError(404, 'Appointment not found');
  return { clinic, appt, ctx };
}

async function reviewView(token) {
  const { clinic, appt } = await loadReview(token);
  return {
    clinic: { name: clinic.name, slug: clinic.slug, logoUrl: clinicView(clinic).logoUrl },
    appointment: { doctorName: appt.doctorName || '', scheduledAt: appt.scheduledAt },
    submitted: !!appt.reviewSubmittedAt,
  };
}

/** Anonymize "Ananya Sharma" → "Ananya S." for the public reviews wall. */
function publicReviewerName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Verified patient';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

async function reviewSubmit(token, { rating, text, name } = {}) {
  const { clinic, appt, ctx } = await loadReview(token);
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) throw new AppError(400, 'Rating must be 1–5 stars');
  if (appt.reviewSubmittedAt) throw new AppError(409, 'A review for this visit was already submitted — thank you!');

  const patient = await tenantRepo(Patient, ctx, { audit: false }).findById(appt.patientId, { lean: true });
  const displayName = publicReviewerName(name || patient?.name || appt.patientName);

  // Append to the website reviews wall (owner moderates: approved=false until published).
  const clinicRepo = tenantRepo(Clinic, ctx); // audited write
  const clinicDoc = await clinicRepo.findOne({});
  if (clinicDoc) {
    const reviews = [...(clinicDoc.website?.reviews || [])];
    reviews.push({ name: displayName, text: String(text || '').trim().slice(0, 1000), rating: stars, approved: false });
    await clinicRepo.updateById(clinicDoc._id, { 'website.reviews': reviews });
  }

  await tenantRepo(Appointment, ctx).updateById(appt._id, { reviewSubmittedAt: new Date() });

  require('./notificationService')
    .emit(ctx, { type: 'review_received', message: `New ${stars}★ review from ${displayName}`, link: '/dashboard/website' })
    .catch(() => {});

  // Happy patients get routed to Google — the flywheel move.
  const googleReviewUrl = stars >= 4 ? String(clinic.crmSettings?.googleReviewUrl || '').trim() : '';
  return { ok: true, rating: stars, googleReviewUrl };
}

// ---- Shared documents (invoice / prescription) ----------------------------------------

async function docView(token) {
  const payload = verifyToken(token, 'doc');
  if (!payload) throw new AppError(404, 'Link expired or invalid');
  const clinic = await resolveClinic(payload.cid);
  requirePlan(clinic, 'DOCUMENT_SHARING');
  const ctx = linkCtx(clinic.clinicId);

  const clinicInfo = { ...clinicView(clinic), gstNumber: clinic.gstNumber || '' };

  if (payload.k === 'invoice') {
    const inv = await tenantRepo(Invoice, ctx, { audit: false }).findById(payload.id, { lean: true });
    if (!inv) throw new AppError(404, 'Document not found');
    // Log the view — a shared invoice link is PHI-adjacent; the owner's activity log should show
    // that (and roughly when) it was opened, mirroring the audited report-bytes path.
    tenantRepo(Invoice, ctx).recordRead(inv._id, { via: 'shared-link' }).catch(() => {});
    return { kind: 'invoice', clinic: clinicInfo, invoice: invoiceView(inv) };
  }
  if (payload.k === 'prescription') {
    const rx = await tenantRepo(Prescription, ctx, { audit: false }).findById(payload.id, { lean: true });
    if (!rx) throw new AppError(404, 'Document not found');
    // A shared prescription exposes diagnosis + full drug list — record every open in the audit log.
    tenantRepo(Prescription, ctx).recordRead(rx._id, { via: 'shared-link' }).catch(() => {});
    return {
      kind: 'prescription',
      clinic: clinicInfo,
      prescription: {
        id: String(rx._id),
        patientName: rx.patientName || '',
        doctorName: rx.doctorName || '',
        diagnosis: rx.diagnosis || '',
        notes: rx.notes || '',
        items: (rx.items || []).map((it) => ({ drug: it.drug, dose: it.dose || '', frequency: it.frequency || '', duration: it.duration || '' })),
        createdAt: rx.createdAt,
      },
    };
  }
  throw new AppError(404, 'Document not found');
}

module.exports = {
  MANAGE_LEAD_MINUTES,
  manageView,
  manageSlots,
  manageReschedule,
  manageCancel,
  payView,
  payOrder,
  payVerify,
  payMockSign,
  reviewView,
  reviewSubmit,
  docView,
};
