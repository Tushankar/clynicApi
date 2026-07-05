'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * medicineOrders — a patient's online store order (Ultra Premium, §6.6 / §7). Lifecycle:
 *   status: pending → verified → fulfilled  (or cancelled)
 *   verificationStatus: not_required | pending | verified | rejected   (pharmacist Rx check)
 *   paymentStatus: unpaid | paid   (synced from the linked GST invoice)
 *
 * Rx enforcement (§5.3): an order with any prescriptionRequired item needs an uploaded prescription
 * (private, signed-URL only, hard rule 3) that a pharmacist VERIFIES before the order can be fulfilled.
 * Fulfillment deducts stock FEFO (the allocations are recorded per item). Per-branch; soft-delete + audited.
 */
const orderItemSchema = new mongoose.Schema(
  {
    medicineId: { type: mongoose.Schema.Types.ObjectId, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true }, // snapshot
    unit: { type: String, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitPrice: { type: Number, min: 0, default: 0 },
    gstRate: { type: Number, min: 0, max: 100, default: 0 },
    prescriptionRequired: { type: Boolean, default: false }, // snapshot at order time
    allocations: { type: [{ batchId: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryBatch' }, qty: Number, _id: false }], default: [] }, // filled on fulfillment (FEFO)
  },
  { _id: false }
);

// Private prescription pointer (hard rule 3): opaque storage key, NEVER a public URL.
const rxFileSchema = new mongoose.Schema(
  {
    storageDriver: { type: String, enum: ['local', 's3', 'cloudinary'] },
    storageKey: { type: String },
    originalName: { type: String, trim: true },
    mimeType: { type: String, trim: true },
    size: { type: Number },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const medicineOrderSchema = new mongoose.Schema(
  {
    orderNumber: { type: String, trim: true }, // per-clinic sequence, e.g. ORD00001
    patientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    patientName: { type: String, trim: true }, // snapshot
    patientEmail: { type: String, trim: true },
    items: { type: [orderItemSchema], default: [] },
    subtotal: { type: Number, min: 0, default: 0 },
    gstAmount: { type: Number, min: 0, default: 0 },
    total: { type: Number, min: 0, default: 0 },

    requiresPrescription: { type: Boolean, default: false },
    prescription: { type: rxFileSchema, default: null },
    verificationStatus: { type: String, enum: ['not_required', 'pending', 'verified', 'rejected'], default: 'not_required' },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    rejectionReason: { type: String, trim: true },

    status: { type: String, enum: ['pending', 'verified', 'fulfilled', 'cancelled'], default: 'pending' },
    fulfilledBy: { type: String, default: null },
    fulfilledAt: { type: Date, default: null },

    invoiceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice', default: null },
    paymentStatus: { type: String, enum: ['unpaid', 'paid'], default: 'unpaid' },

    contactPhone: { type: String, trim: true, maxlength: 30 },
    deliveryAddress: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(medicineOrderSchema);
branchAware(medicineOrderSchema);
softDeletable(medicineOrderSchema);
medicineOrderSchema.index({ clinicId: 1, patientId: 1, createdAt: -1 });
medicineOrderSchema.index({ clinicId: 1, status: 1, createdAt: -1 });
medicineOrderSchema.index({ clinicId: 1, verificationStatus: 1 });

module.exports = mongoose.model('MedicineOrder', medicineOrderSchema);
