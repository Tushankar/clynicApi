'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * inventoryBatches — physical pharmacy stock as batches/lots (Ultra Premium, §6.3 / §7).
 *
 * Each row is a specific lot of a medicine at a branch: its own batch number, expiry,
 * quantity on hand, and purchase cost. Live availability of a medicine = the sum of
 * quantityInStock across its NON-EXPIRED batches (computed on read). Stock is per-branch
 * (branchAware); the catalog definition (Medicine) is clinic-wide. Financial/stock record →
 * soft-deletable + audited via the tenant repo (hard rules 6, 7).
 *
 * Stock-integrity rules (module §5): quantity never goes negative, FEFO deduction, and
 * expired batches are never dispensed/sold — enforced by the dispensing/order flows in
 * UP-C/UP-D. purchaseOrderId links a batch to the GRN that created it (UP-B); null when a
 * batch is entered manually.
 */
const inventoryBatchSchema = new mongoose.Schema(
  {
    medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
    batchNo: { type: String, trim: true, maxlength: 80 },
    expiryDate: { type: Date, required: true },
    quantityInStock: { type: Number, min: 0, default: 0 },
    purchaseUnitCost: { type: Number, min: 0, default: 0 }, // ₹ cost per unit for valuation/margin
    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null }, // set by GRN in UP-B
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(inventoryBatchSchema);
branchAware(inventoryBatchSchema);
softDeletable(inventoryBatchSchema);
inventoryBatchSchema.index({ clinicId: 1, medicineId: 1 }); // availability lookups per medicine
inventoryBatchSchema.index({ clinicId: 1, expiryDate: 1 }); // expiry alerts / FEFO ordering

module.exports = mongoose.model('InventoryBatch', inventoryBatchSchema);
