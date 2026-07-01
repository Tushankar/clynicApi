'use strict';

const asyncHandler = require('../utils/asyncHandler');
const publicService = require('../services/publicService');

const getClinic = asyncHandler(async (req, res) => {
  res.json(await publicService.getPublicClinic(req.params.slug));
});

const slots = asyncHandler(async (req, res) => {
  res.json(await publicService.getPublicSlots(req.params.slug, { doctorId: req.query.doctorId, date: req.query.date }));
});

const requestOtp = asyncHandler(async (req, res) => {
  res.json(await publicService.requestBookingOtp(req.params.slug, req.body.email));
});

const verifyOtp = asyncHandler(async (req, res) => {
  res.json(await publicService.verifyBookingOtp(req.params.slug, req.body.email, req.body.code));
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

module.exports = { getClinic, slots, requestOtp, verifyOtp, book, queue, prepayOrder, prepayVerify, prepayMockSign, aiFaq, aiSymptomIntake, voiceTurn };
