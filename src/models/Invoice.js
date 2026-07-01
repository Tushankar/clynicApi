'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * invoices — financial record (hard rules 6, 7, 8). Soft-deletable, audited,
 * branch-aware. Totals are computed server-side; never trust client amounts.
 */
const lineItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true, trim: true },
    amount: { type: Number, required: true, min: 0 }, // unit amount (₹)
    quantity: { type: Number, default: 1, min: 1 },
  },
  { _id: false }
);

const paymentEntrySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'upi', 'card', 'online'], required: true },
    reference: { type: String, trim: true }, // razorpay paymentId, UPI ref, etc.
    paidAt: { type: Date, default: Date.now },
    byStaffId: { type: String, default: null },
  },
  { _id: false }
);

const refundEntrySchema = new mongoose.Schema(
  {
    amount: { type: Number, required: true, min: 0 },
    reason: { type: String, trim: true },
    at: { type: Date, default: Date.now },
    byStaffId: { type: String, default: null },
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    invoiceNumber: { type: String, required: true }, // per-clinic sequence (INV-00001)
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    appointmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    patientName: { type: String, trim: true },

    items: { type: [lineItemSchema], default: [] },
    subtotal: { type: Number, default: 0, min: 0 },
    gstRate: { type: Number, default: 0, min: 0, max: 100 }, // percent
    gstAmount: { type: Number, default: 0, min: 0 },
    total: { type: Number, default: 0, min: 0 },

    status: { type: String, enum: ['draft', 'unpaid', 'partially_paid', 'paid', 'refunded', 'cancelled'], default: 'unpaid' },
    prepaid: { type: Boolean, default: false },

    amountPaid: { type: Number, default: 0 },
    amountRefunded: { type: Number, default: 0 },
    payments: { type: [paymentEntrySchema], default: [] },
    refunds: { type: [refundEntrySchema], default: [] },
  },
  { timestamps: true }
);

clinicScoped(invoiceSchema);
branchAware(invoiceSchema);
softDeletable(invoiceSchema);

invoiceSchema.index({ clinicId: 1, createdAt: -1 });
invoiceSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });
invoiceSchema.index({ clinicId: 1, appointmentId: 1 });
invoiceSchema.index({ clinicId: 1, status: 1 });
invoiceSchema.index({ clinicId: 1, invoiceNumber: 1 }, { unique: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
