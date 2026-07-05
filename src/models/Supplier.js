'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * suppliers — external distributors/vendors the pharmacy BUYS stock from (Ultra Premium, §6.1 / §7).
 *
 * Clinic-wide vendor records (like the medicine catalog, NOT branch-scoped — a supplier serves the
 * whole clinic). Commercial record → soft-deletable + audited via the tenant repo (hard rules 6, 7).
 */
const supplierSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    contactPerson: { type: String, trim: true, maxlength: 120 },
    phone: { type: String, trim: true, maxlength: 30 },
    email: { type: String, trim: true, maxlength: 200 },
    gstNumber: { type: String, trim: true, maxlength: 30 },
    address: { type: String, trim: true, maxlength: 500 },
    notes: { type: String, trim: true, maxlength: 1000 },
    active: { type: Boolean, default: true },
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(supplierSchema);
softDeletable(supplierSchema);
supplierSchema.index({ clinicId: 1, name: 1 });

module.exports = mongoose.model('Supplier', supplierSchema);
