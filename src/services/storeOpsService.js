'use strict';

const { MedicineOrder } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const dispenseService = require('./dispenseService');
const storeOrderService = require('./storeOrderService');
const invoiceService = require('./invoiceService');
const alertService = require('./pharmacyAlertService');
const notificationService = require('./notificationService');
const storage = require('../lib/storage');
const AppError = require('../utils/AppError');

/**
 * Pharmacy-staff order queue (Ultra Premium, §6.6). Runs behind Clerk auth + requireFeature
 * (PHARMACY_STOREFRONT). Pharmacists verify/reject uploaded prescriptions and fulfil orders.
 *
 * Rx enforcement (§5.3): fulfil() is BLOCKED unless verificationStatus is 'not_required' or 'verified'
 * — an Rx order with a pending/rejected prescription can never be fulfilled. Fulfilment deducts stock
 * FEFO (reusing dispenseService's atomic, concurrency-safe allocation) with full rollback on shortfall.
 */
function repo(ctx) {
  return tenantRepo(MedicineOrder, ctx);
}

async function list(ctx, { status, verificationStatus } = {}) {
  const filter = {};
  if (typeof status === 'string') filter.status = status;
  if (typeof verificationStatus === 'string') filter.verificationStatus = verificationStatus;
  const orders = await repo(ctx).find(filter, { sort: { createdAt: -1 }, limit: 500, lean: true });
  const items = [];
  for (const o of orders) items.push(storeOrderService.orderView(o, { paid: await storeOrderService.invoicePaid(ctx, o.invoiceId) }));
  return { items };
}

async function get(ctx, id) {
  const order = await repo(ctx).findById(id);
  if (!order) throw new AppError(404, 'Order not found');
  const paid = await storeOrderService.invoicePaid(ctx, order.invoiceId);
  const view = storeOrderService.orderView(order, { paid });
  // Pharmacist can view the uploaded prescription via a short-lived signed URL (hard rule 3 — private).
  if (order.prescription && order.prescription.storageKey) {
    // .url (absolute), never .path — the SPA is served from a different origin than the API, so a
    // relative path resolves against the SPA and returns index.html. The pharmacist must actually
    // SEE the prescription they are verifying (rule 3 + Schedule-H compliance).
    view.prescriptionUrl = storage.getSignedUrl({ clinicId: ctx.clinicId, key: order.prescription.storageKey, meta: { mime: order.prescription.mimeType || 'application/octet-stream' } }).url;
  }
  return view;
}

async function verifyRx(ctx, id) {
  const order = await repo(ctx).findById(id);
  if (!order) throw new AppError(404, 'Order not found');
  if (!order.requiresPrescription) throw new AppError(400, 'This order does not require a prescription');
  if (!(order.prescription && order.prescription.storageKey)) throw new AppError(400, 'No prescription has been uploaded to verify');
  if (order.verificationStatus === 'verified') return storeOrderService.orderView(order);
  const saved = await repo(ctx).updateById(id, { verificationStatus: 'verified', verifiedBy: ctx.actorId || null, verifiedAt: new Date(), rejectionReason: '' });
  notificationService.emit(ctx, { type: 'order_status', message: `Prescription verified for order ${order.orderNumber}`, recipientType: 'patient', recipientId: String(order.patientId) }).catch(() => {});
  return storeOrderService.orderView(saved);
}

async function rejectRx(ctx, id, reason) {
  const order = await repo(ctx).findById(id);
  if (!order) throw new AppError(404, 'Order not found');
  if (!order.requiresPrescription) throw new AppError(400, 'This order does not require a prescription');
  const saved = await repo(ctx).updateById(id, { verificationStatus: 'rejected', rejectionReason: String(reason || '').trim().slice(0, 300) || 'Prescription not valid — please re-upload' });
  notificationService.emit(ctx, { type: 'order_status', message: `Prescription needs attention for order ${order.orderNumber}`, recipientType: 'patient', recipientId: String(order.patientId) }).catch(() => {});
  return storeOrderService.orderView(saved);
}

/**
 * Fulfil an order: deduct stock FEFO and mark fulfilled. Enforces payment + Rx verification first.
 */
async function fulfill(ctx, id) {
  const order = await repo(ctx).findById(id);
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status === 'fulfilled') throw new AppError(409, 'This order was already fulfilled');
  if (order.status === 'cancelled') throw new AppError(400, 'This order is cancelled');
  if (!order.items?.length) throw new AppError(400, 'This order has no items');
  // Rx enforcement (§5.3): never fulfil an Rx order whose prescription is not verified.
  if (order.requiresPrescription && order.verificationStatus !== 'verified') {
    throw new AppError(400, 'The prescription must be verified before this order can be fulfilled');
  }
  // Must be paid (settled through the linked invoice) before handing stock over.
  if (!(await storeOrderService.invoicePaid(ctx, order.invoiceId))) throw new AppError(400, 'This order is not paid yet');

  // Atomically CLAIM fulfilment BEFORE deducting stock: only the request that flips the status from a
  // non-terminal state wins, so two concurrent fulfils (a double-click, or two staff on the queue) can
  // never both deduct. The per-batch decrements only prevent oversell — this prevents double-deduct.
  const prevStatus = order.status;
  const claim = await MedicineOrder.updateOne(
    { _id: order._id, clinicId: ctx.clinicId, status: { $in: ['pending', 'verified'] } },
    { $set: { status: 'fulfilled', fulfilledBy: ctx.actorId || null, fulfilledAt: new Date() } }
  );
  if (!claim.modifiedCount) throw new AppError(409, 'This order is already being fulfilled');

  // FEFO deduction (atomic, no-oversell, no-expired). On any failure roll back stock AND revert the
  // claim so the order can be retried cleanly.
  const allAllocations = [];
  const perItem = [];
  try {
    for (const it of order.items) {
      const { allocations, shortfall } = await dispenseService.allocateFEFO(ctx, it.medicineId, order.branchId, it.qty);
      allAllocations.push(...allocations);
      perItem.push(allocations);
      if (shortfall > 0) throw new AppError(409, `Insufficient in-date stock for ${it.medicineName}: short by ${shortfall} ${it.unit || 'unit'}(s)`);
    }
  } catch (err) {
    await dispenseService.rollbackAllocations(ctx, allAllocations);
    await MedicineOrder.updateOne({ _id: order._id, clinicId: ctx.clinicId }, { $set: { status: prevStatus, fulfilledBy: null, fulfilledAt: null } }).catch(() => {});
    throw err;
  }

  const items = order.items.map((it, i) => ({
    medicineId: it.medicineId, medicineName: it.medicineName, unit: it.unit, qty: it.qty,
    unitPrice: it.unitPrice, gstRate: it.gstRate, prescriptionRequired: it.prescriptionRequired, allocations: perItem[i],
  }));
  const saved = await repo(ctx).updateById(id, { items }); // status already committed by the atomic claim
  for (const mid of [...new Set(order.items.map((i) => String(i.medicineId)))]) alertService.checkMedicine(ctx, mid).catch(() => {});
  notificationService.emit(ctx, { type: 'order_status', message: `Your order ${order.orderNumber} is ready`, recipientType: 'patient', recipientId: String(order.patientId) }).catch(() => {});
  return storeOrderService.orderView(saved);
}

async function cancel(ctx, id, reason) {
  const order = await repo(ctx).findById(id);
  if (!order) throw new AppError(404, 'Order not found');
  if (order.status === 'fulfilled') throw new AppError(400, 'A fulfilled order cannot be cancelled here (issue a refund in billing)');
  const saved = await repo(ctx).updateById(id, { status: 'cancelled', notes: [order.notes, reason ? `Cancelled: ${String(reason).slice(0, 200)}` : ''].filter(Boolean).join(' · ') });

  // Void the order's invoice so a cancelled order stops appearing as an outstanding due. Cancel
  // used to leave the invoice live and payable, so the clinic kept billing for goods it had
  // decided not to ship. Only an UNPAID invoice is voided here; if money was already captured the
  // invoice is left intact and a refund is required, which is a deliberate human decision.
  if (order.invoiceId) {
    try {
      const alreadyPaid = await storeOrderService.invoicePaid(ctx, order.invoiceId);
      if (!alreadyPaid) {
        await invoiceService.softDelete(ctx, order.invoiceId);
      } else {
        notificationService
          .emit(ctx, {
            type: 'other',
            message: `Order ${order.orderNumber} was cancelled but its invoice is already PAID — a refund is required.`,
            link: '/dashboard/billing',
          })
          .catch(() => {});
      }
    } catch (err) {
      // Never let invoice cleanup undo the cancellation itself; surface it for reconciliation.
      // eslint-disable-next-line no-console
      console.error(`[storeOpsService] cancel: invoice ${order.invoiceId} not voided for order ${order._id}:`, err?.message || err);
    }
  }

  notificationService.emit(ctx, { type: 'order_status', message: `Order ${order.orderNumber} was cancelled`, recipientType: 'patient', recipientId: String(order.patientId) }).catch(() => {});
  return storeOrderService.orderView(saved);
}

module.exports = { list, get, verifyRx, rejectRx, fulfill, cancel };
