'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * medicineCategories — storefront browse categories (Ultra Premium, §6.6 / §7). Clinic-wide, with an
 * optional private image (Apollo-style category tiles). Medicines are matched to a category by their
 * free-text `category` field == this category's name (case-insensitive), so no change to the Medicine
 * catalog is required. Soft-deletable + audited.
 */
const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, trim: true, lowercase: true, maxlength: 120 },
    description: { type: String, trim: true, maxlength: 500 },
    imageStorageDriver: { type: String, enum: ['local', 's3', 'cloudinary'], default: null },
    imageStorageKey: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(categorySchema);
softDeletable(categorySchema);
// One slug per clinic among LIVE categories (partial index, like Medicine.sku).
categorySchema.index({ clinicId: 1, slug: 1 }, { unique: true, partialFilterExpression: { slug: { $type: 'string' }, deletedAt: null } });
categorySchema.index({ clinicId: 1, sortOrder: 1 });

module.exports = mongoose.model('MedicineCategory', categorySchema);
