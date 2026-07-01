'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');
const { PLANS } = require('../config/plans');

/**
 * clinics — the tenant root. clinicId === Clerk Organization ID.
 * For this collection clinicId equals the org id of the clinic the doc describes,
 * which keeps it uniform with every other tenant collection.
 */
const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, lowercase: true }, // for the public booking URL /c/:slug
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    gstNumber: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    publicPageContent: { type: mongoose.Schema.Types.Mixed }, // structured content for the public site (Phase 4)
    subscriptionPlan: { type: String, enum: PLANS, default: 'basic', required: true },
  },
  { timestamps: true }
);

// One clinic doc per org (unique clinicId).
clinicScoped(clinicSchema, { unique: true });

// Public lookups by slug (section 6). Slug is globally unique for subdomain routing.
clinicSchema.index({ slug: 1 }, { unique: true, sparse: true });
clinicSchema.index({ clinicId: 1, slug: 1 });

module.exports = mongoose.model('Clinic', clinicSchema);
