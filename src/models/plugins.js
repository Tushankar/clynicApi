'use strict';

/**
 * Reusable Mongoose schema plugins that encode the hard rules at the schema level.
 *
 * - clinicScoped  -> hard rule 1 (tenant isolation): every tenant collection carries clinicId.
 * - softDeletable -> hard rule 6 (soft delete): deletedAt/deletedBy + the index that lets
 *                    default queries cheaply exclude soft-deleted docs.
 * - branchAware   -> hard rule 8 (branch-aware): operational docs carry branchId from day one,
 *                    even when a clinic has a single branch. (No Phase 0 model is operational,
 *                    but appointments/queue/invoices in Phase 1+ apply this.)
 *
 * NOTE: clinicId is a STRING because it is the Clerk Organization ID (e.g. "org_2ab..."),
 * not a Mongo ObjectId. Same for any Clerk user id (actorId, deletedBy, clerkUserId).
 */

function clinicScoped(schema, { unique = false } = {}) {
  schema.add({
    clinicId: { type: String, required: true },
  });
  // The plugin owns the clinicId index so there is exactly one definition for it.
  // `unique` is for the tenant-root collection (clinics): one doc per org.
  schema.index({ clinicId: 1 }, unique ? { unique: true } : {});
}

function softDeletable(schema) {
  schema.add({
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: null }, // Clerk user id of the deleter
  });
  // Default queries filter { clinicId, deletedAt: null }; index supports that.
  schema.index({ clinicId: 1, deletedAt: 1 });
}

function branchAware(schema, { required = false } = {}) {
  schema.add({
    branchId: { type: require('mongoose').Schema.Types.ObjectId, ref: 'Branch', required },
  });
  schema.index({ clinicId: 1, branchId: 1 });
}

module.exports = { clinicScoped, softDeletable, branchAware };
