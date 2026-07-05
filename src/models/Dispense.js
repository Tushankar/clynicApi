'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * dispenses — a fulfillment of a doctor's prescription at the pharmacy counter (Ultra Premium, §6.4).
 *
 * The prescription stays the CLINICAL source; a dispense is the fulfillment that actually deducts
 * stock. Every dispense is linked to a valid clinic prescription (Rx enforcement, §5.3) — auditing
 * the dispense create serves as the H1-register-style log (§12). Each item records the FEFO batch
 * `allocations` it drew from (a single dispensed line may span multiple batches). Per-branch;
 * soft-deletable + audited (hard rules 6, 7, 8).
 */
const allocationSchema = new mongoose.Schema(
  {
    batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryBatch', required: true },
    qty: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const dispenseItemSchema = new mongoose.Schema(
  {
    medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true }, // snapshot for history
    unit: { type: String, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, min: 0, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    allocations: { type: [allocationSchema], default: [] }, // which batches this line drew from (FEFO)
    dosage: { type: String, trim: true }, // e.g. "1-0-1"
    timing: { type: String, trim: true }, // e.g. "after food"
    durationDays: { type: Number, min: 0, default: null },
    instructions: { type: String, trim: true },
  },
  { _id: false }
);

const dispenseSchema = new mongoose.Schema(
  {
    prescriptionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Prescription', required: true },
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    patientName: { type: String, trim: true }, // snapshot
    doctorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Doctor', default: null },
    items: { type: [dispenseItemSchema], default: [] },
    total: { type: Number, min: 0, default: 0 },
    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    // Client-generated idempotency key: a retried/double-submitted "Dispense & bill" reuses the same
    // token so the second request is a no-op (returns the first dispense) — never a duplicate deduction/invoice.
    clientToken: { type: String, default: null },
    dispensedBy: { type: String, default: null }, // Clerk user id
    dispensedAt: { type: Date, default: Date.now },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(dispenseSchema);
branchAware(dispenseSchema);
softDeletable(dispenseSchema);
dispenseSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });
dispenseSchema.index({ clinicId: 1, prescriptionId: 1 });
dispenseSchema.index({ dispensedAt: -1 }); // platform-wide (super-admin) GMV rollup

module.exports = mongoose.model('Dispense', dispenseSchema);
