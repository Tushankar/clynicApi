'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * purchaseOrders — procurement documents (Ultra Premium, §6.1 / §7). A PO orders medicines from a
 * supplier; receiving it (GRN) creates inventory batches + records a purchase expense. Per-branch
 * (the branch that orders/receives). Financial record → soft-deletable + audited (hard rules 6, 7).
 *
 * Lines snapshot medicineName/unit at creation so the PO reads correctly as history even if the
 * catalog item is later renamed or removed. batchNo/mfg/expiry are finalized at receipt (GRN).
 */
const PO_STATUSES = ['draft', 'ordered', 'received', 'cancelled'];

const poItemSchema = new mongoose.Schema(
  {
    medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true }, // snapshot for history
    unit: { type: String, trim: true }, // snapshot
    qty: { type: Number, required: true, min: 1 },
    unitCost: { type: Number, min: 0, default: 0 },
    batchNo: { type: String, trim: true, maxlength: 80 },
    mfgDate: { type: Date, default: null },
    expiryDate: { type: Date, default: null }, // required before a line can be received
  },
  { _id: true }
);

const purchaseOrderSchema = new mongoose.Schema(
  {
    poNumber: { type: String, trim: true }, // per-clinic sequence, e.g. PO00001
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    supplierName: { type: String, trim: true }, // snapshot for history
    items: { type: [poItemSchema], default: [] },
    totalCost: { type: Number, min: 0, default: 0 },
    status: { type: String, enum: PO_STATUSES, default: 'draft' },
    orderedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    notes: { type: String, trim: true, maxlength: 1000 },
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(purchaseOrderSchema);
branchAware(purchaseOrderSchema);
softDeletable(purchaseOrderSchema);
purchaseOrderSchema.index({ clinicId: 1, supplierId: 1 });
purchaseOrderSchema.index({ clinicId: 1, status: 1, createdAt: -1 });

purchaseOrderSchema.statics.STATUSES = PO_STATUSES;

module.exports = mongoose.model('PurchaseOrder', purchaseOrderSchema);
