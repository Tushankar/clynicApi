'use strict';

const { Clinic, Patient, Prescription, Invoice, Appointment, Report, Payment, QueueEntry } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const otpService = require('./otpService');
const patientService = require('./patientService');
const reportService = require('./reportService');
const paymentService = require('./paymentService');
const queueService = require('./queueService');
const branchService = require('./branchService');
const patientSession = require('../lib/patientSession');
const gateway = require('../lib/payments');
const config = require('../config/env');
const AppError = require('../utils/AppError');

async function resolveClinic(slug) {
  const clinic = await Clinic.findOne({ slug: String(slug || '').toLowerCase().trim() }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  if (!planHasFeature(clinic.subscriptionPlan, 'PATIENT_PORTAL')) {
    throw new AppError(403, 'Patient portal is not available on this clinic’s plan', { error: 'upgrade_required', feature: 'PATIENT_PORTAL' });
  }
  return clinic;
}

// ---- Auth ----
// `contact` is an email OR a mobile number — a patient with only a phone on file can still log in
// (code delivered via WhatsApp when the clinic has it connected).
async function requestLogin(slug, contact) {
  const clinic = await resolveClinic(slug);
  return otpService.requestOtp(clinic.clinicId, contact);
}

async function verifyLogin(slug, contact, code) {
  const clinic = await resolveClinic(slug);
  await otpService.verifyOtp(clinic.clinicId, contact, code); // throws on wrong/expired
  const ctx = { clinicId: clinic.clinicId, actorId: 'portal', actorRole: null };
  const c = otpService.classify(contact);
  // Look up BEFORE consuming the code — otherwise a correct code for a contact with no record
  // burns the single-use OTP.
  // EVERY patient on this contact, not the first one Mongo happens to return. A shared household
  // phone/email legitimately maps to several distinct records (findOrCreatePatient creates them on
  // purpose), and silently binding the session to one of them let a family member land in another
  // person's chart — prescriptions, lab reports, invoices.
  const matches = c && c.kind === 'email'
    ? await patientService.findAllByContact(ctx, { email: c.identifier })
    : await patientService.findAllByContact(ctx, { phone: c ? c.identifier : contact });
  if (!matches.length) throw new AppError(404, 'No records found for that email or number. Please book an appointment first.');
  await otpService.consumeVerified(clinic.clinicId, contact); // single-use — consumed only on success

  if (matches.length > 1) {
    // Ask WHO is signing in. The selection token proves the OTP was verified (the code is now
    // spent) and pins the allowed candidates, so the follow-up call cannot name any other patient.
    const selectionToken = patientSession.sign({
      clinicId: clinic.clinicId,
      candidateIds: matches.map((p) => String(p._id)),
      aud: patientSession.AUDIENCE.PORTAL_SELECT,
      exp: Date.now() + 5 * 60 * 1000, // 5 minutes to choose
    });
    return {
      needsSelection: true,
      selectionToken,
      // Name only — just enough to recognise yourself, no other identifying detail.
      candidates: matches.map((p) => ({ id: String(p._id), name: p.name })),
    };
  }

  return issueSession(clinic.clinicId, matches[0]);
}

/** Mint the real portal session for a resolved patient. */
function issueSession(clinicId, patient) {
  const token = patientSession.sign({
    clinicId,
    patientId: String(patient._id),
    email: patient.email || null,
    aud: patientSession.AUDIENCE.PORTAL, // this token must not unlock the storefront session
    exp: Date.now() + config.patientSessionTtlHours * 3600 * 1000,
  });
  return { token, patient: { id: String(patient._id), name: patient.name, email: patient.email || null } };
}

/**
 * Second step of a disambiguated login: exchange the selection token + chosen patient for a
 * session. The chosen id MUST be one of the candidates the selection token was minted with, so a
 * tampered request cannot reach an unrelated patient.
 */
async function selectPatient(slug, selectionToken, patientId) {
  const clinic = await resolveClinic(slug);
  const data = patientSession.verifyFor(selectionToken, patientSession.AUDIENCE.PORTAL_SELECT);
  if (!data || data.clinicId !== clinic.clinicId) throw new AppError(401, 'That sign-in attempt expired. Please request a new code.');
  if (!Array.isArray(data.candidateIds) || !data.candidateIds.includes(String(patientId))) {
    throw new AppError(403, 'Please choose one of the listed people.');
  }
  const ctx = { clinicId: clinic.clinicId, actorId: 'portal', actorRole: null };
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');
  return issueSession(clinic.clinicId, patient);
}

// ---- Patient-scoped reads (req.ctx + req.patient.patientId set by patientAuth) ----
function me(req) {
  return tenantRepo(Patient, req.ctx).findById(req.patient.patientId);
}
function prescriptions(req) {
  return tenantRepo(Prescription, req.ctx).find({ patientId: req.patient.patientId }, { sort: { createdAt: -1 }, lean: true });
}
function invoices(req) {
  return tenantRepo(Invoice, req.ctx).find({ patientId: req.patient.patientId }, { sort: { createdAt: -1 }, lean: true });
}
function appointments(req) {
  return tenantRepo(Appointment, req.ctx).find({ patientId: req.patient.patientId }, { sort: { scheduledAt: -1 }, lean: true });
}
function reports(req) {
  return tenantRepo(Report, req.ctx).find({ patientId: req.patient.patientId }, { sort: { createdAt: -1 }, lean: true });
}

async function assertOwnReport(req, reportId) {
  const r = await tenantRepo(Report, req.ctx).findById(reportId);
  if (!r || String(r.patientId) !== String(req.patient.patientId)) throw new AppError(404, 'Report not found');
  return r;
}

async function reportSignedUrl(req, reportId) {
  await assertOwnReport(req, reportId); // a patient can only sign-URL their OWN reports
  return reportService.getSignedUrl(req.ctx, reportId);
}

function uploadReport(req, { type, title, file }) {
  // patientId forced from the session — a patient can only upload to their own record.
  return reportService.upload(req.ctx, { patientId: req.patient.patientId, type, title, file });
}

async function queue(req) {
  const branch = await branchService.getOrCreatePrimaryBranch(req.ctx);
  const snap = await queueService.snapshot(req.ctx, branch._id, { display: true });
  // Personalize: find THIS patient's own live queue entry and their position, so the portal answers
  // the one question they opened it for — "how long until me?" — instead of a generic lobby board.
  const entry = await tenantRepo(QueueEntry, req.ctx, { audit: false }).findOne(
    { patientId: req.patient.patientId, status: { $in: ['waiting', 'called', 'in_consultation'] } },
    { lean: true }
  );
  let you = null;
  if (entry) {
    const idx = snap.waiting.findIndex((w) => w.token === entry.tokenNumber);
    you = {
      token: entry.tokenNumber,
      status: entry.status,
      position: idx >= 0 ? idx + 1 : 0, // 0 = being seen / called
      waitMinutes: idx >= 0 ? snap.waiting[idx].waitMinutes : 0,
    };
  }
  return { ...snap, you };
}

// ---- Pay an invoice from the portal ----
async function assertOwnInvoice(req, invoiceId) {
  const inv = await tenantRepo(Invoice, req.ctx).findById(invoiceId);
  if (!inv || String(inv.patientId) !== String(req.patient.patientId)) throw new AppError(404, 'Invoice not found');
  return inv;
}
async function payInvoiceOrder(req, invoiceId) {
  await assertOwnInvoice(req, invoiceId);
  return paymentService.createInvoiceOrder(req.ctx, invoiceId);
}
async function payInvoiceVerify(req, body) {
  // Ownership: the order being verified must belong to THIS patient (defense in depth
  // on top of the server-side signature check) — a patient can't credit another's invoice.
  const payment = await Payment.findOne({ clinicId: req.patient.clinicId, orderId: body.orderId });
  if (!payment || String(payment.patientId) !== String(req.patient.patientId)) {
    throw new AppError(404, 'Payment not found');
  }
  return paymentService.verifyPayment(req.ctx, body);
}
function payMockSign(req, { orderId, paymentId }) {
  if (config.payments.driver !== 'mock') throw new AppError(404, 'Not found');
  const pid = paymentId || `pay_mock_${Date.now()}`;
  return { paymentId: pid, signature: gateway.devSignPayment(orderId, pid) };
}

module.exports = {
  requestLogin,
  verifyLogin,
  selectPatient,
  me,
  prescriptions,
  invoices,
  appointments,
  reports,
  reportSignedUrl,
  uploadReport,
  queue,
  payInvoiceOrder,
  payInvoiceVerify,
  payMockSign,
};
