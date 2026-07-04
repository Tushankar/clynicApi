'use strict';

const { Clinic, Doctor, Appointment, Patient } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { dayRange, parseDateOnly, dateKey } = require('../lib/datetime');
const { generateSlots } = require('../lib/availability');
const { ACTIVE_STATUSES } = require('../config/appointments');
const appointmentService = require('./appointmentService');
const patientService = require('./patientService');
const otpService = require('./otpService');
const queueService = require('./queueService');
const branchService = require('./branchService');
const prepaymentService = require('./prepaymentService');
const paymentService = require('./paymentService');
const aiService = require('./aiService');
const gateway = require('../lib/payments');
const { planHasFeature } = require('../config/plans');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Public booking service (no Clerk auth). Resolves clinicId from the page slug and
 * scopes everything to it — public callers can never reach another clinic's data.
 */
async function resolveClinic(slug) {
  const clinic = await Clinic.findOne({ slug: String(slug || '').toLowerCase().trim() }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  return clinic;
}

function publicCtx(clinic) {
  return { clinicId: clinic.clinicId, actorId: 'public', actorRole: null };
}

async function getPublicClinic(slug) {
  const clinic = await resolveClinic(slug);
  const ctx = publicCtx(clinic);
  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { sort: { name: 1 }, lean: true });
  return {
    clinic: {
      name: clinic.name,
      slug: clinic.slug,
      logoUrl: /^https?:\/\//i.test(clinic.logoUrl || '') ? clinic.logoUrl : '', // http(s) only — no data:/javascript:
      address: clinic.address,
      phone: clinic.phone,
      about: clinic.publicPageContent?.about || null,
      ai: planHasFeature(clinic.subscriptionPlan, 'AI_FEATURES'), // gates the patient-facing AI widgets
    },
    doctors: doctors.map((d) => ({
      id: String(d._id),
      name: d.name,
      specialization: d.specialization,
      consultationFee: d.consultationFee,
    })),
  };
}

async function getPublicSlots(slug, { doctorId, date }) {
  const clinic = await resolveClinic(slug);
  const ctx = publicCtx(clinic);
  const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
  if (!doctor || !doctor.isActive) throw new AppError(404, 'Doctor not found');

  const day = date ? parseDateOnly(date) : new Date();
  const { start, end } = dayRange(day);
  const [booked, blocks] = await Promise.all([
    tenantRepo(Appointment, ctx).find(
      { doctorId, scheduledAt: { $gte: start, $lte: end }, status: { $in: ACTIVE_STATUSES } },
      { lean: true }
    ),
    require('./availabilityBlockService').blocksFor(ctx, { doctorId, from: start, to: end }),
  ]);
  const slots = generateSlots({
    doctor,
    date: day,
    bookedStarts: booked.map((b) => b.scheduledAt),
    leadMinutes: 30, // don't offer slots starting in the next 30 minutes
    blocks, // doctor leave / clinic holidays never surface as bookable (§5.20)
  });
  // waitlistAvailable → the booking page can offer "join the waitlist" when the day is full.
  return { date: dateKey(day), doctorId, slots, waitlistAvailable: planHasFeature(clinic.subscriptionPlan, 'WAITLIST') };
}

function requestBookingOtp(slug, contact) {
  return resolveClinic(slug).then((c) => otpService.requestOtp(c.clinicId, contact));
}

function verifyBookingOtp(slug, contact, code) {
  return resolveClinic(slug).then((c) => otpService.verifyOtp(c.clinicId, contact, code));
}

async function publicBook(slug, payload) {
  const clinic = await resolveClinic(slug);
  const ctx = publicCtx(clinic);
  const { name, phone, email, doctorId, scheduledAt, reason } = payload;
  if (!name) throw new AppError(400, 'Your name is required');
  // Contact = email OR mobile — a patient without an email can verify by phone (WhatsApp/SMS).
  const contact = email || phone;
  if (!contact) throw new AppError(400, 'An email or mobile number is required');

  // Contact ownership must be proven first (the verified identity is what was OTP-checked).
  const verified = await otpService.consumeVerified(clinic.clinicId, contact);
  if (!verified) throw new AppError(401, 'Please verify your email or mobile number before booking');

  // Reuse an existing patient by EXACT verified email (or normalized phone) — never a fuzzy
  // match — and create a DISTINCT record when the same contact is used for a different person
  // (family on a shared number/email), so histories never merge (hard rule 1 + patient safety).
  const { patient: matchedPatient } = await patientService.findOrCreatePatient(ctx, { name, phone, email });
  const patientId = matchedPatient._id;

  const appt = await appointmentService.book(ctx, { doctorId, patientId, scheduledAt, source: 'online', reason });

  // Prepayment: if the clinic plan + doctor fee require it, the appointment stays
  // 'booked' (unconfirmed) until a verified online payment confirms it (step 5 / 9.x).
  const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
  const prepay = prepaymentService.prepaymentRequired(clinic.subscriptionPlan, doctor);

  // Self-service manage link (§5.20) — shown on the success ticket AND sent in the
  // confirmation message so the patient can reschedule/cancel without calling.
  const selfService = planHasFeature(clinic.subscriptionPlan, 'SELF_RESCHEDULE');
  const manageUrl = selfService ? require('../lib/publicLinks').manageUrl(clinic.clinicId, appt._id) : '';
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (patient) {
    require('./commsService').sendBookingConfirmation(ctx, clinic, patient, appt).catch(() => {});
  }

  return {
    token: appt.tokenNumber,
    appointmentId: String(appt._id),
    scheduledAt: appt.scheduledAt,
    doctorName: appt.doctorName,
    status: appt.status,
    manageUrl,
    prepayment: prepay ? { required: true, amount: Number(doctor.consultationFee) } : { required: false },
  };
}

/** Public: join the cancellation waitlist for a doctor+day (§5.21, plan-gated). */
async function joinWaitlist(slug, payload) {
  const clinic = await resolveClinic(slug);
  return require('./waitlistService').joinPublic(clinic, payload);
}

// ---- Public prepayment (no Clerk auth; clinic resolved from slug) ----
async function prepaymentOrder(slug, appointmentId) {
  const clinic = await resolveClinic(slug);
  return prepaymentService.createOrder(publicCtx(clinic), appointmentId);
}

async function prepaymentVerify(slug, { orderId, paymentId, signature }) {
  const clinic = await resolveClinic(slug);
  return paymentService.verifyPayment(publicCtx(clinic), { orderId, paymentId, signature });
}

async function prepaymentMockSign(slug, { orderId, paymentId }) {
  if (config.payments.driver !== 'mock') throw new AppError(404, 'Not found');
  await resolveClinic(slug);
  const pid = paymentId || `pay_mock_${Date.now()}`;
  return { paymentId: pid, signature: gateway.devSignPayment(orderId, pid) };
}

/** Display-safe queue snapshot for the waiting-room TV (no auth; first names only). */
async function getPublicQueue(slug, branchId) {
  const clinic = await resolveClinic(slug);
  const ctx = publicCtx(clinic);
  let bId = branchId;
  if (!bId) bId = (await branchService.getOrCreatePrimaryBranch(ctx))._id;
  const snapshot = await queueService.snapshot(ctx, bId, { display: true });
  return { clinicId: clinic.clinicId, branchId: String(bId), clinicName: clinic.name, snapshot };
}

// ---- Public AI (patient-facing; rule 2 enforced in aiService/guard) ----
// Gated by the clinic's plan (AI_FEATURES). If not enabled, the feature is simply absent
// to the public (404) — patients never see staff-facing "upgrade" prompts.
function assertAiEnabled(clinic) {
  if (!planHasFeature(clinic.subscriptionPlan, 'AI_FEATURES')) throw new AppError(404, 'Not available');
}

async function publicFaq(slug, question) {
  const clinic = await resolveClinic(slug);
  assertAiEnabled(clinic);
  return aiService.faq(publicCtx(clinic), clinic, question);
}

async function publicSymptomIntake(slug, { appointmentId, symptomsText }) {
  const clinic = await resolveClinic(slug);
  assertAiEnabled(clinic);
  const ctx = publicCtx(clinic);
  // Derive the patient from THIS clinic's appointment — a public caller can't target
  // an arbitrary patientId (tenant isolation, hard rule 1).
  const appt = await tenantRepo(Appointment, ctx).findById(appointmentId);
  if (!appt) throw new AppError(404, 'Appointment not found');
  return aiService.symptomIntake(ctx, { patientId: appt.patientId, appointmentId: appt._id, symptomsText });
}

// Voice receptionist turn (step 9). Gated by the clinic's AI plan. Lazy-require avoids a
// module cycle (voiceService itself uses publicService for slot lookups).
async function publicVoiceTurn(slug, { sessionId, text, callerPhone }) {
  const clinic = await resolveClinic(slug);
  assertAiEnabled(clinic);
  return require('./voiceService').handleTurn(clinic, { sessionId, text, callerPhone });
}

module.exports = {
  resolveClinic,
  getPublicClinic,
  getPublicSlots,
  requestBookingOtp,
  verifyBookingOtp,
  publicBook,
  joinWaitlist,
  getPublicQueue,
  prepaymentOrder,
  prepaymentVerify,
  prepaymentMockSign,
  publicFaq,
  publicSymptomIntake,
  publicVoiceTurn,
};
