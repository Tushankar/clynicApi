'use strict';

const crypto = require('crypto');
const { MedicineOrder, Medicine, Patient, Invoice, Payment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { nextSequence } = require('../lib/sequence');
const branchService = require('./branchService');
const invoiceService = require('./invoiceService');
const paymentService = require('./paymentService');
const inventoryService = require('./pharmacyInventoryService');
const notificationService = require('./notificationService');
const storage = require('../lib/storage');
const gateway = require('../lib/payments');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Patient-facing storefront order flow (Ultra Premium, §6.6). Runs behind storePatientAuth, so ctx +
 * patient are the token's own clinic + patient (tenant isolation). A GST invoice is created via the
 * EXISTING invoiceService and paid via the EXISTING Razorpay flow (createInvoiceOrder → verifyPayment
 * → recordPayment) — no change to those services. Rx-required orders must carry an uploaded prescription
 * (private, signed-URL only) that a pharmacist verifies before the order can be fulfilled (§5.3).
 */
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const safeName = (n) => String(n || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
const ALLOWED_RX_MIME = /^(image\/(jpeg|png|webp|heic|heif)|application\/pdf)$/i;

async function ownOrder(ctx, patient, orderId) {
  const order = await tenantRepo(MedicineOrder, ctx).findById(orderId);
  if (!order || String(order.patientId) !== String(patient.patientId)) throw new AppError(404, 'Order not found');
  return order;
}

/** Authoritative paid check straight from the linked invoice (webhook-safe, not the cached flag). */
async function invoicePaid(ctx, invoiceId) {
  if (!invoiceId) return false;
  const inv = await tenantRepo(Invoice, ctx, { audit: false }).findById(invoiceId, { lean: true });
  return !!(inv && inv.total > 0 && inv.amountPaid >= inv.total);
}

function orderView(order, { paid } = {}) {
  const o = order.toObject ? order.toObject() : order;
  return {
    id: String(o._id),
    orderNumber: o.orderNumber,
    patientName: o.patientName || '',
    items: o.items,
    subtotal: o.subtotal,
    gstAmount: o.gstAmount,
    total: o.total,
    requiresPrescription: o.requiresPrescription,
    hasPrescription: !!(o.prescription && o.prescription.storageKey),
    prescriptionMimeType: o.prescription && o.prescription.mimeType ? o.prescription.mimeType : null,
    verificationStatus: o.verificationStatus,
    rejectionReason: o.rejectionReason || null,
    status: o.status,
    paymentStatus: paid !== undefined ? (paid ? 'paid' : o.paymentStatus) : o.paymentStatus,
    createdAt: o.createdAt,
    fulfilledAt: o.fulfilledAt || null,
    contactPhone: o.contactPhone || '',
    deliveryAddress: o.deliveryAddress || '',
  };
}

async function createOrder(ctx, patient, { items, contactPhone, deliveryAddress, notes } = {}) {
  if (!Array.isArray(items) || !items.length) throw new AppError(400, 'Your cart is empty');
  const medIds = [...new Set(items.map((i) => i && i.medicineId).filter(Boolean).map(String))];
  const meds = medIds.length ? await tenantRepo(Medicine, ctx, { audit: false }).find({ _id: { $in: medIds }, active: { $ne: false } }, { lean: true }) : [];
  const medById = Object.fromEntries(meds.map((m) => [String(m._id), m]));
  const availMap = await inventoryService.availabilityMap(ctx, { medicineIds: meds.map((m) => m._id) });

  const orderItems = items.map((it, idx) => {
    const med = medById[String(it.medicineId)];
    if (!med) throw new AppError(400, `Line ${idx + 1}: this item is unavailable`);
    if (med.sellingPrice == null || med.sellingPrice <= 0) throw new AppError(400, `${med.name} is not available for online purchase`);
    const qty = Math.floor(Number(it.qty));
    if (!Number.isFinite(qty) || qty < 1) throw new AppError(400, `${med.name}: invalid quantity`);
    const available = availMap[String(med._id)] ? availMap[String(med._id)].available || 0 : 0;
    if (qty > available) throw new AppError(409, `${med.name}: only ${available} in stock`);
    return { medicineId: med._id, medicineName: med.name, unit: med.unit || 'unit', qty, unitPrice: med.sellingPrice, gstRate: med.gstRate || 0, prescriptionRequired: !!med.prescriptionRequired };
  });

  const subtotal = round2(orderItems.reduce((s, i) => s + i.qty * i.unitPrice, 0));
  const gstAmount = round2(orderItems.reduce((s, i) => s + i.qty * i.unitPrice * (i.gstRate / 100), 0));
  const total = round2(subtotal + gstAmount);
  const requiresPrescription = orderItems.some((i) => i.prescriptionRequired);

  const patientDoc = await tenantRepo(Patient, ctx, { audit: false }).findById(patient.patientId, { lean: true });
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const seq = await nextSequence(ctx.clinicId, 'medicineOrder');

  // GST invoice via the existing billing service (blended rate → invoice GST == sum of per-line GST).
  const blendedRate = subtotal > 0 ? round2((gstAmount / subtotal) * 100) : 0;
  const invoice = await invoiceService.create(ctx, {
    patientId: patient.patientId,
    items: orderItems.map((i) => ({ description: `${i.medicineName} × ${i.qty}`, amount: i.unitPrice, quantity: i.qty })),
    gstRate: blendedRate,
  });

  const order = await tenantRepo(MedicineOrder, ctx).create({
    orderNumber: 'ORD' + String(seq).padStart(5, '0'),
    patientId: patient.patientId,
    patientName: patientDoc ? patientDoc.name : patient.email,
    patientEmail: patient.email,
    items: orderItems,
    // Use the INVOICE's authoritative totals (what the patient is actually charged) so the order
    // record can never drift from the invoice due to blended-rate rounding.
    subtotal: invoice.subtotal,
    gstAmount: invoice.gstAmount,
    total: invoice.total,
    requiresPrescription,
    verificationStatus: requiresPrescription ? 'pending' : 'not_required',
    status: 'pending',
    invoiceId: invoice._id,
    paymentStatus: 'unpaid',
    branchId: branch._id,
    contactPhone: String(contactPhone || '').trim().slice(0, 30),
    deliveryAddress: String(deliveryAddress || '').trim().slice(0, 500),
    notes: String(notes || '').trim().slice(0, 500),
    createdBy: ctx.actorId || null,
  });

  notificationService.emit(ctx, { type: 'store_order', message: `New store order ${order.orderNumber} — ₹${total}${requiresPrescription ? ' (Rx — needs verification)' : ''}`, link: '/dashboard/pharmacy/orders' }).catch(() => {});
  return orderView(order);
}

async function uploadPrescription(ctx, patient, orderId, file) {
  if (!file || !file.buffer || !file.buffer.length) throw new AppError(400, 'No file uploaded');
  if (!ALLOWED_RX_MIME.test(file.mimetype || '')) throw new AppError(400, 'Upload a prescription image (JPG/PNG/WebP) or PDF');
  const order = await ownOrder(ctx, patient, orderId);
  if (order.status === 'cancelled') throw new AppError(400, 'This order is cancelled');
  // Never let the Rx file change after fulfilment — that would corrupt the dispensing/audit record.
  if (order.status === 'fulfilled') throw new AppError(400, 'This order has already been fulfilled');
  const key = `pharmacy/prescriptions/${ctx.clinicId}/${crypto.randomUUID()}-${safeName(file.originalname)}`;
  await storage.saveFile({ clinicId: ctx.clinicId, key, buffer: file.buffer, contentType: file.mimetype });
  const update = {
    prescription: { storageDriver: storage.driver, storageKey: key, originalName: safeName(file.originalname), mimeType: file.mimetype, size: file.size, uploadedAt: new Date() },
  };
  // Any (re)upload INVALIDATES prior review: the 'verified' flag must never outlive the file it
  // certified (§5.3). Swapping the file — even after a pharmacist verified it — forces a fresh review,
  // so fulfilment can never dispense against a prescription no pharmacist approved for THIS file.
  if (order.requiresPrescription) {
    update.verificationStatus = 'pending';
    update.verifiedBy = null;
    update.verifiedAt = null;
    update.rejectionReason = '';
  }
  const saved = await tenantRepo(MedicineOrder, ctx).updateById(orderId, update);
  return orderView(saved);
}

async function payOrder(ctx, patient, orderId) {
  const order = await ownOrder(ctx, patient, orderId);
  if (!order.invoiceId) throw new AppError(400, 'This order has no invoice to pay');
  if (await invoicePaid(ctx, order.invoiceId)) throw new AppError(400, 'This order is already paid');
  return paymentService.createInvoiceOrder(ctx, order.invoiceId);
}

async function verifyPayment(ctx, patient, orderId, body = {}) {
  const order = await ownOrder(ctx, patient, orderId);
  // Ownership defense-in-depth (copied from portalService.payInvoiceVerify): the gateway order must
  // belong to this patient before we apply the signature-verified capture.
  const payment = await Payment.findOne({ clinicId: ctx.clinicId, orderId: body.orderId });
  if (!payment || String(payment.patientId) !== String(patient.patientId)) throw new AppError(404, 'Payment not found');
  const result = await paymentService.verifyPayment(ctx, body); // server-side signature check + apply
  // Sync the order's cached paymentStatus from the (authoritative) invoice.
  if (await invoicePaid(ctx, order.invoiceId)) await tenantRepo(MedicineOrder, ctx).updateById(orderId, { paymentStatus: 'paid' });
  return { ...result, order: orderView(await tenantRepo(MedicineOrder, ctx).findById(orderId), { paid: await invoicePaid(ctx, order.invoiceId) }) };
}

function mockSign(orderId, paymentId) {
  if (config.payments.driver !== 'mock') throw new AppError(404, 'Not found');
  const pid = paymentId || `pay_mock_${Date.now()}`;
  return { paymentId: pid, signature: gateway.devSignPayment(orderId, pid) };
}

async function listMine(ctx, patient) {
  const orders = await tenantRepo(MedicineOrder, ctx).find({ patientId: patient.patientId }, { sort: { createdAt: -1 }, limit: 100, lean: true });
  // Derive live paid status from each invoice (webhook-safe display).
  const views = [];
  for (const o of orders) views.push(orderView(o, { paid: await invoicePaid(ctx, o.invoiceId) }));
  return { items: views };
}

async function getMine(ctx, patient, orderId) {
  const order = await ownOrder(ctx, patient, orderId);
  const paid = await invoicePaid(ctx, order.invoiceId);
  const view = orderView(order, { paid });
  // The patient may view their OWN uploaded prescription via a short-lived signed URL.
  if (order.prescription && order.prescription.storageKey) {
    view.prescriptionUrl = storage.getSignedUrl({ clinicId: ctx.clinicId, key: order.prescription.storageKey, meta: { mime: order.prescription.mimeType || 'application/octet-stream' } }).path;
  }
  return view;
}

module.exports = { createOrder, uploadPrescription, payOrder, verifyPayment, mockSign, listMine, getMine, ownOrder, invoicePaid, orderView };
