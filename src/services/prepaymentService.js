'use strict';

const { Appointment, Doctor, Payment } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const gateway = require('../lib/payments');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/** Prepayment is offered when the clinic has the feature AND the doctor charges a fee. */
function prepaymentRequired(plan, doctor) {
  return planHasFeature(plan, 'ONLINE_PREPAYMENT') && Number(doctor?.consultationFee) > 0;
}

/** Create a Razorpay order for an appointment's consultation fee (server-side amount). */
async function createOrder(ctx, appointmentId) {
  const appt = await tenantRepo(Appointment, ctx).findById(appointmentId);
  if (!appt) throw new AppError(404, 'Appointment not found');
  if (appt.prepaid) throw new AppError(400, 'Already paid');
  const doctor = await tenantRepo(Doctor, ctx).findById(appt.doctorId);
  const amount = Number(doctor?.consultationFee) || 0;
  if (!(amount > 0)) throw new AppError(400, 'No prepayment amount configured for this doctor');

  // Reuse an existing OPEN prepayment order for this appointment instead of minting a new one, so a
  // patient who reloads the pay step can't create a second order that later double-charges.
  const open = await Payment.findOne({ clinicId: ctx.clinicId, kind: 'prepayment', appointmentId: appt._id, status: { $in: ['created', 'processing'] } }).sort({ createdAt: -1 });
  if (open && Number(open.amount) === amount) {
    return { orderId: open.orderId, amount: open.amount, currency: open.currency, keyId: config.payments.keyId, driver: gateway.driver, reused: true };
  }

  const order = await gateway.createOrder({ amount, currency: config.payments.currency, receipt: String(appt._id) });
  await tenantRepo(Payment, ctx).create({
    kind: 'prepayment',
    appointmentId: appt._id,
    patientId: appt.patientId,
    branchId: appt.branchId,
    provider: gateway.driver,
    orderId: order.id,
    amount,
    currency: order.currency,
    status: 'created',
  });
  return { orderId: order.id, amount, currency: order.currency, keyId: order.keyId, driver: gateway.driver };
}

/**
 * Mark an appointment prepaid (called by paymentService after a VERIFIED payment).
 * Confirms the appointment if it was still merely booked. Audited via the tenant repo.
 */
async function markPrepaid(ctx, appointmentId, paymentId) {
  const repo = tenantRepo(Appointment, ctx);
  const appt = await repo.findById(appointmentId);
  if (!appt) return null;
  if (!appt.prepaid) await repo.updateById(appointmentId, { prepaid: true, prepaymentId: paymentId || appt.prepaymentId });
  // Let a genuine confirm failure propagate so the (idempotent) webhook/callback retries;
  // a retry finds prepaid already set and the status no longer 'booked', so it's a no-op.
  if (appt.status === 'booked') {
    await require('./appointmentService').transition(ctx, appointmentId, 'confirmed');
  }
  return true;
}

module.exports = { prepaymentRequired, createOrder, markPrepaid };
