'use strict';

const asyncHandler = require('../utils/asyncHandler');
const publicService = require('../services/publicService');
const selfServiceService = require('../services/selfServiceService');
const checkinService = require('../services/checkinService');

const getClinic = asyncHandler(async (req, res) => {
  res.json(await publicService.getPublicClinic(req.params.slug));
});

const slots = asyncHandler(async (req, res) => {
  res.json(await publicService.getPublicSlots(req.params.slug, { doctorId: req.query.doctorId, date: req.query.date }));
});

const requestOtp = asyncHandler(async (req, res) => {
  res.json(await publicService.requestBookingOtp(req.params.slug, req.body.contact || req.body.email || req.body.phone));
});

const verifyOtp = asyncHandler(async (req, res) => {
  res.json(await publicService.verifyBookingOtp(req.params.slug, req.body.contact || req.body.email || req.body.phone, req.body.code));
});

const book = asyncHandler(async (req, res) => {
  res.status(201).json(await publicService.publicBook(req.params.slug, req.body));
});

const queue = asyncHandler(async (req, res) => {
  res.json(await publicService.getPublicQueue(req.params.slug, req.query.branchId));
});

const prepayOrder = asyncHandler(async (req, res) => {
  res.json(await publicService.prepaymentOrder(req.params.slug, req.params.appointmentId));
});
const prepayVerify = asyncHandler(async (req, res) => {
  res.json(await publicService.prepaymentVerify(req.params.slug, { orderId: req.body.orderId, paymentId: req.body.paymentId, signature: req.body.signature }));
});
const prepayMockSign = asyncHandler(async (req, res) => {
  res.json(await publicService.prepaymentMockSign(req.params.slug, { orderId: req.body.orderId, paymentId: req.body.paymentId }));
});

const aiFaq = asyncHandler(async (req, res) => {
  res.json(await publicService.publicFaq(req.params.slug, req.body.question));
});
const aiSymptomIntake = asyncHandler(async (req, res) => {
  res.status(201).json(await publicService.publicSymptomIntake(req.params.slug, { appointmentId: req.body.appointmentId, symptomsText: req.body.symptomsText }));
});

// Voice receptionist webhook: one dialog turn. A telephony provider (Twilio/Exotel) posts the
// transcribed utterance + call id here and speaks back the returned `say` (see infra doc).
const voiceTurn = asyncHandler(async (req, res) => {
  res.json(await publicService.publicVoiceTurn(req.params.slug, { sessionId: req.body.sessionId, text: req.body.text, callerPhone: req.body.callerPhone }));
});

// ---- Patient self-service via tokenized links (§5.20+) — no slug; the token binds the clinic.
const manageView = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.manageView(req.params.token));
});
const manageSlots = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.manageSlots(req.params.token, req.query.date));
});
const manageReschedule = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.manageReschedule(req.params.token, req.body.scheduledAt));
});
const manageCancel = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.manageCancel(req.params.token, req.body.reason));
});

const payView = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.payView(req.params.token));
});
const payOrder = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.payOrder(req.params.token));
});
const payVerify = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.payVerify(req.params.token, { orderId: req.body.orderId, paymentId: req.body.paymentId, signature: req.body.signature }));
});
const payMockSign = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.payMockSign(req.params.token, { orderId: req.body.orderId, paymentId: req.body.paymentId }));
});

const reviewView = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.reviewView(req.params.token));
});
const reviewSubmit = asyncHandler(async (req, res) => {
  res.status(201).json(await selfServiceService.reviewSubmit(req.params.token, { rating: req.body.rating, text: req.body.text, name: req.body.name }));
});

const docView = asyncHandler(async (req, res) => {
  res.json(await selfServiceService.docView(req.params.token));
});

// ---- Waitlist + QR self check-in (slug-scoped) ----------------------------------------
const joinWaitlist = asyncHandler(async (req, res) => {
  res.status(201).json(
    await publicService.joinWaitlist(req.params.slug, {
      doctorId: req.body.doctorId,
      date: req.body.date,
      name: req.body.name,
      phone: req.body.phone,
      email: req.body.email,
    })
  );
});
const checkinContext = asyncHandler(async (req, res) => {
  res.json(await checkinService.context(req.params.slug));
});
const selfCheckin = asyncHandler(async (req, res) => {
  res.json(await checkinService.selfCheckin(req.params.slug, { phone: req.body.phone, appointmentId: req.body.appointmentId }));
});

module.exports = {
  getClinic,
  slots,
  requestOtp,
  verifyOtp,
  book,
  queue,
  prepayOrder,
  prepayVerify,
  prepayMockSign,
  aiFaq,
  aiSymptomIntake,
  voiceTurn,
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
  joinWaitlist,
  checkinContext,
  selfCheckin,
};
