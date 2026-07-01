'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * branches — physical locations of a clinic. Every clinic has >= 1 branch.
 * Multi-branch management UI is a Premium feature (Phase 4), but operational documents
 * reference a branchId from day one (hard rule 8). Soft-deletable (hard rule 6) so a
 * closed branch is retired, never hard-deleted (its historical appointments/invoices stay valid).
 */
const branchSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    isPrimary: { type: Boolean, default: false },
  },
  { timestamps: true }
);

clinicScoped(branchSchema);
softDeletable(branchSchema);

module.exports = mongoose.model('Branch', branchSchema);
