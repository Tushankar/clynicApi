'use strict';

const { Clinic, Patient, Prescription, Invoice, Appointment, Report, Payment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const otpService = require('./otpService');
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
async function requestLogin(slug, email) {
  const clinic = await resolveClinic(slug);
  return otpService.requestOtp(clinic.clinicId, email);
}

async function verifyLogin(slug, email, code) {
  const clinic = await resolveClinic(slug);
  await otpService.verifyOtp(clinic.clinicId, email, code); // throws on wrong/expired
  await otpService.consumeVerified(clinic.clinicId, email); // single-use
  const ctx = { clinicId: clinic.clinicId, actorId: 'portal', actorRole: null };
  const patient = await tenantRepo(Patient, ctx).findOne({ email: String(email).toLowerCase().trim() });
  if (!patient) throw new AppError(404, 'No records found for this email. Please book an appointment first.');
  const token = patientSession.sign({
    clinicId: clinic.clinicId,
    patientId: String(patient._id),
    email: patient.email,
    exp: Date.now() + config.patientSessionTtlHours * 3600 * 1000,
  });
  return { token, patient: { id: String(patient._id), name: patient.name, email: patient.email } };
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
  return queueService.snapshot(req.ctx, branch._id, { display: true });
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
