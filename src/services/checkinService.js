'use strict';

const { Appointment, QueueEntry } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { dayRange } = require('../lib/datetime');
const { planHasFeature } = require('../config/plans');
const AppError = require('../utils/AppError');

/**
 * QR self check-in (§5.24, Premium). The clinic prints a QR pointing at
 * /c/:slug/checkin; the patient scans it at the door, enters their phone number,
 * and their booked appointment for TODAY is checked in → they join the live queue
 * and see their token + position on their own phone. Reuses the exact same
 * transition + queue path as the front desk, so nothing can drift.
 *
 * Privacy: the response carries only what the waiting-room TV already shows
 * (first name, token, position) — never other patients' details.
 */

function publicCtx(clinic) {
  return { clinicId: clinic.clinicId, actorId: 'self-checkin', actorRole: null };
}

const digits = (s) => String(s || '').replace(/\D/g, '');
const firstName = (name) => String(name || 'Patient').trim().split(/\s+/)[0];

function assertEnabled(clinic) {
  if (!planHasFeature(clinic.subscriptionPlan, 'SELF_CHECKIN')) throw new AppError(404, 'Not available');
}

/** Kiosk page context — clinic identity only. */
async function context(slug) {
  const publicService = require('./publicService');
  const clinic = await publicService.resolveClinic(slug);
  assertEnabled(clinic);
  return {
    clinic: {
      name: clinic.name,
      slug: clinic.slug,
      logoUrl: /^https?:\/\//i.test(clinic.logoUrl || '') ? clinic.logoUrl : '',
    },
  };
}

async function queuePosition(ctx, appointment) {
  const entry = await tenantRepo(QueueEntry, ctx, { audit: false }).findOne({ appointmentId: appointment._id }, { lean: true });
  if (!entry) return null;
  const queueService = require('./queueService');
  const snap = await queueService.snapshot(ctx, entry.branchId, { display: true });
  const idx = snap.waiting.findIndex((w) => w.token === entry.tokenNumber);
  return {
    branchId: String(entry.branchId),
    status: entry.status,
    position: idx >= 0 ? idx + 1 : 0, // 0 = being seen / called
    waitMinutes: idx >= 0 ? snap.waiting[idx].waitMinutes : 0,
    nowServing: snap.nowServing.map((e) => e.token),
  };
}

function checkinView(appointment, queue) {
  return {
    token: appointment.tokenNumber,
    name: firstName(appointment.patientName),
    doctorName: appointment.doctorName || '',
    scheduledAt: appointment.scheduledAt,
    status: appointment.status,
    queue,
  };
}

/**
 * Check in by phone number. Finds TODAY's active appointments whose patient phone ends with the
 * entered digits; idempotent — scanning twice just shows the status. When a SHARED number has more
 * than one person booked today (the family norm — father + son on one mobile), we return the list
 * so the scanner can pick WHO is checking in, instead of silently checking in the earliest one.
 * `appointmentId` selects the chosen person on the second call.
 */
async function selfCheckin(slug, { phone, appointmentId } = {}) {
  const publicService = require('./publicService');
  const clinic = await publicService.resolveClinic(slug);
  assertEnabled(clinic);
  const ctx = publicCtx(clinic);

  const tail = digits(phone).slice(-10);
  if (tail.length < 10) throw new AppError(400, 'Please enter the 10-digit mobile number used for the booking');

  const { start, end } = dayRange(new Date());
  const todays = await tenantRepo(Appointment, ctx, { audit: false }).find(
    { scheduledAt: { $gte: start, $lte: end }, status: { $in: ['booked', 'confirmed', 'checked_in', 'in_consultation'] } },
    { sort: { scheduledAt: 1 }, lean: true }
  );
  const matches = todays.filter((a) => digits(a.patientPhone).slice(-10) === tail);
  if (!matches.length) {
    throw new AppError(404, "We couldn't find a booking for today with that number. Please check with the front desk.");
  }

  const doCheckIn = async (appt) => {
    if (['checked_in', 'in_consultation'].includes(appt.status)) {
      return { already: true, ...checkinView(appt, await queuePosition(ctx, appt)) };
    }
    const appointmentService = require('./appointmentService');
    const { appointment, queueEntry } = await appointmentService.checkIn(ctx, appt._id);
    const queue = await queuePosition(ctx, { _id: appointment._id, tokenNumber: queueEntry?.tokenNumber ?? appointment.tokenNumber });
    return { already: false, ...checkinView(appointment, queue) };
  };

  // A specific person was chosen from the list — check that one in (must be on this number).
  if (appointmentId) {
    const chosen = matches.find((a) => String(a._id) === String(appointmentId));
    if (!chosen) throw new AppError(404, 'That appointment is no longer available. Please scan again.');
    return doCheckIn(chosen);
  }

  // More than one person booked today on this number, none yet in-flow → ask WHO is checking in.
  const notInFlow = matches.filter((a) => !['checked_in', 'in_consultation'].includes(a.status));
  if (matches.length > 1 && notInFlow.length > 1) {
    return {
      chooseFrom: matches.map((a) => ({
        appointmentId: String(a._id),
        name: firstName(a.patientName),
        doctorName: a.doctorName || '',
        token: a.tokenNumber,
        scheduledAt: a.scheduledAt,
        status: a.status,
      })),
    };
  }

  // Single relevant match: an in-flow one shows status; otherwise check the earliest in.
  const inFlow = matches.find((a) => ['checked_in', 'in_consultation'].includes(a.status));
  return doCheckIn(inFlow || notInFlow[0] || matches[0]);
}

module.exports = { context, selfCheckin };
