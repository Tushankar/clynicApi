'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');

/**
 * auditLogs — append-only accountability trail (hard rule 7).
 * Written automatically by the tenant data layer on create/update/delete.
 * Never soft-deletable, never updated, never written through the tenant repo
 * (that would recurse). Medical software needs this — do not skip.
 */
const auditLogSchema = new mongoose.Schema(
  {
    actorId: { type: String, default: null }, // Clerk user id of who did it (null = system)
    actorRole: { type: String, default: null },
    action: { type: String, enum: ['create', 'update', 'delete', 'restore', 'read'], required: true },
    entityType: { type: String, required: true }, // model name, e.g. 'Patient'
    entityId: { type: mongoose.Schema.Types.Mixed, required: true },
    before: { type: mongoose.Schema.Types.Mixed }, // optional snapshot pre-change
    after: { type: mongoose.Schema.Types.Mixed }, // optional snapshot post-change
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

clinicScoped(auditLogSchema);

auditLogSchema.index({ clinicId: 1, createdAt: -1 });
auditLogSchema.index({ clinicId: 1, entityType: 1, entityId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
