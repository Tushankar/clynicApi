'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * medicines — the pharmacy's product catalog (Ultra Premium module, §6.2 / §7).
 *
 * A medicine is a clinic-wide product DEFINITION (name, salt, form, price, Rx flag).
 * It is NOT branch-aware: the same "Paracetamol 500mg" definition is shared across a
 * clinic's branches; physical stock lives per-branch in inventoryBatches. Clinical/
 * commercial record → soft-deletable + audited via the tenant repo (hard rules 6, 7).
 *
 * Compliance fields (prescriptionRequired / scheduleClass) are captured at catalog time
 * so the data is complete; the actual dispense/sale ENFORCEMENT lands in UP-C/UP-D.
 */
const MEDICINE_FORMS = ['tablet', 'capsule', 'syrup', 'injection', 'ointment', 'drops', 'inhaler', 'powder', 'other'];
// The stocking/selling unit — how inventory quantity is counted for this product.
const MEDICINE_UNITS = ['strip', 'tablet', 'capsule', 'bottle', 'tube', 'ml', 'box', 'sachet', 'unit'];
// Drug schedule (India). OTC sells freely; H/H1/X require a valid prescription (§12).
const SCHEDULE_CLASSES = ['OTC', 'H', 'H1', 'X'];

const medicineSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    brand: { type: String, trim: true, maxlength: 200 },
    composition: { type: String, trim: true, maxlength: 300 }, // salt / active ingredient(s)
    category: { type: String, trim: true, maxlength: 120 },
    symptomTags: { type: [{ type: String, trim: true, lowercase: true, maxlength: 40 }], default: [] }, // OTC/wellness browse (§6.6); Rx-by-symptom never surfaced (§5.4)
    form: { type: String, enum: MEDICINE_FORMS, default: 'other' },
    strength: { type: String, trim: true, maxlength: 60 }, // e.g. "500mg", "5ml"
    unit: { type: String, enum: MEDICINE_UNITS, default: 'unit' },
    sku: { type: String, trim: true, maxlength: 60 }, // optional per-clinic stock-keeping code
    hsnCode: { type: String, trim: true, maxlength: 20 }, // GST HSN (§6.2)
    gstRate: { type: Number, min: 0, max: 100, default: 0 }, // % GST
    sellingPrice: { type: Number, min: 0, default: null }, // ₹ per unit; used by billing/store later
    reorderLevel: { type: Number, min: 0, default: 0 }, // low-stock alert threshold (§6.3)
    prescriptionRequired: { type: Boolean, default: false }, // Schedule H/H1/X → true (§12)
    scheduleClass: { type: String, enum: SCHEDULE_CLASSES, default: 'OTC' },
    description: { type: String, trim: true, maxlength: 2000 },
    dosageInfo: { type: String, trim: true, maxlength: 1000 }, // standard/label dosage guidance
    // Primary catalog image — stored privately (hard rule 3): we keep the opaque storage KEY,
    // never a public URL, and hand clients a short-lived signed URL on read.
    imageStorageDriver: { type: String, enum: ['local', 's3', 'cloudinary'], default: null },
    imageStorageKey: { type: String, default: null },
    active: { type: Boolean, default: true }, // inactive = hidden from dispensing/store, kept for history
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(medicineSchema);
softDeletable(medicineSchema);
medicineSchema.index({ clinicId: 1, name: 1 });
medicineSchema.index({ clinicId: 1, category: 1 });
// One SKU per clinic WHEN SET, among LIVE medicines only. A partial index (not sparse) is
// required: a compound `sparse` index still indexes docs where only some keys are present, so
// many blank-SKU medicines would collide on (clinicId, null). partialFilterExpression indexes
// ONLY docs whose sku is a string, so unset/blank SKUs (undefined or null) are excluded and
// never collide. The `deletedAt: null` clause keeps soft-deleted rows OUT of the constraint —
// otherwise a deleted medicine would permanently burn its SKU (soft-delete must not fetter live
// data). softDeletable stores deletedAt:null on every live doc, so live docs stay constrained.
medicineSchema.index(
  { clinicId: 1, sku: 1 },
  { unique: true, partialFilterExpression: { sku: { $type: 'string' }, deletedAt: null } }
);
// Text search over catalog fields (used by inventory search now; storefront search in UP-D).
medicineSchema.index({ name: 'text', brand: 'text', composition: 'text' });

medicineSchema.statics.FORMS = MEDICINE_FORMS;
medicineSchema.statics.UNITS = MEDICINE_UNITS;
medicineSchema.statics.SCHEDULE_CLASSES = SCHEDULE_CLASSES;

module.exports = mongoose.model('Medicine', medicineSchema);
