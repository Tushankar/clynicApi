'use strict';

const asyncHandler = require('../utils/asyncHandler');
const storeService = require('../services/storeService');
const storeOrderService = require('../services/storeOrderService');

/* ---- Public storefront browse (slug in path, no auth, Ultra-404-gated in the service) ---- */
const home = asyncHandler(async (req, res) => res.json(await storeService.home(req.params.slug)));
const categories = asyncHandler(async (req, res) => res.json(await storeService.categories(req.params.slug)));
const category = asyncHandler(async (req, res) => res.json(await storeService.categoryItems(req.params.slug, req.params.catSlug)));
const symptom = asyncHandler(async (req, res) => res.json(await storeService.symptomItems(req.params.slug, req.params.tag)));
const search = asyncHandler(async (req, res) => res.json(await storeService.search(req.params.slug, req.query.q)));
const product = asyncHandler(async (req, res) => res.json(await storeService.product(req.params.slug, req.params.id)));

/* ---- Email-OTP auth (public; verify mints a patient session for checkout) ---- */
const otpRequest = asyncHandler(async (req, res) => res.json(await storeService.requestOtp(req.params.slug, req.body.email)));
const otpVerify = asyncHandler(async (req, res) => res.json(await storeService.verifyOtp(req.params.slug, req.body)));

/* ---- Patient order flow (behind storePatientAuth → req.ctx + req.patient) ---- */
const me = asyncHandler(async (req, res) => res.json({ patient: req.patient }));
const createOrder = asyncHandler(async (req, res) => res.status(201).json(await storeOrderService.createOrder(req.ctx, req.patient, req.body)));
const uploadPrescription = asyncHandler(async (req, res) => res.json(await storeOrderService.uploadPrescription(req.ctx, req.patient, req.params.id, req.file)));
const payOrder = asyncHandler(async (req, res) => res.json(await storeOrderService.payOrder(req.ctx, req.patient, req.params.id)));
const verifyPayment = asyncHandler(async (req, res) => res.json(await storeOrderService.verifyPayment(req.ctx, req.patient, req.params.id, req.body)));
const mockSign = asyncHandler(async (req, res) => res.json(storeOrderService.mockSign(req.body.orderId, req.body.paymentId)));
const listOrders = asyncHandler(async (req, res) => res.json(await storeOrderService.listMine(req.ctx, req.patient)));
const getOrder = asyncHandler(async (req, res) => res.json(await storeOrderService.getMine(req.ctx, req.patient, req.params.id)));

module.exports = {
  // public browse
  home, categories, category, symptom, search, product, otpRequest, otpVerify,
  // patient order flow
  me, createOrder, uploadPrescription, payOrder, verifyPayment, mockSign, listOrders, getOrder,
};
