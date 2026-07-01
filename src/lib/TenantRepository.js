'use strict';

const AuditLog = require('../models/AuditLog');
const AppError = require('../utils/AppError');

/**
 * ============================================================================
 *  TenantRepository — the shared tenant-scoped data-access layer.
 * ============================================================================
 *
 * This single layer enforces three hard rules so NO feature has to remember them:
 *
 *   Rule 1 (tenant isolation): every query is filtered by ctx.clinicId, and any
 *           clinicId in the input is ignored/overridden. A query without a clinicId
 *           context throws — treat that as a bug, never a silent full-collection scan.
 *   Rule 6 (soft delete): for soft-deletable models, default reads exclude
 *           { deletedAt: { $ne: null } }, and delete is a soft delete that sets
 *           deletedAt + deletedBy. We never hard-delete clinical/financial data.
 *   Rule 7 (audit log): create/update/delete write an auditLogs entry
 *           (who, what, when, before/after).
 *
 * USAGE
 * -----
 *   const { tenantRepo } = require('../lib/TenantRepository');
 *   const repo = tenantRepo(Patient, req.ctx);   // req.ctx = { clinicId, actorId, actorRole }
 *
 *   await repo.create({ name, phone });           // clinicId injected, audit written
 *   await repo.find({ phone });                   // scoped + soft-delete-excluded
 *   await repo.findById(id);
 *   await repo.updateById(id, { name });          // audit before/after
 *   await repo.softDeleteById(id);                // sets deletedAt/deletedBy + audit
 *
 * Pass { includeDeleted: true } in read options to include soft-deleted docs
 * (e.g. for admin/restore flows). Never bypass this layer for tenant collections.
 */

const STRIP_ON_WRITE = ['clinicId', '_id', 'id', 'deletedAt', 'deletedBy', 'createdAt', 'updatedAt'];

function sanitizeInput(data) {
  const clean = { ...(data || {}) };
  for (const key of STRIP_ON_WRITE) delete clean[key];
  return clean;
}

class TenantRepository {
  /**
   * @param {import('mongoose').Model} Model
   * @param {{ clinicId: string, actorId?: string, actorRole?: string }} ctx
   * @param {{ audit?: boolean }} [options]
   */
  constructor(Model, ctx, options = {}) {
    if (!Model) throw new Error('TenantRepository requires a Mongoose model');
    if (!ctx || !ctx.clinicId) {
      // Hard rule 1: a tenant query without a clinicId is a bug, not a wildcard.
      throw new AppError(500, 'TenantRepository requires a clinicId in context');
    }
    this.Model = Model;
    this.ctx = ctx;
    this.entityType = Model.modelName;
    this.isSoftDeletable = !!Model.schema.path('deletedAt');
    // Audit everything by default; the AuditLog model is never wrapped (would recurse).
    this.auditEnabled = options.audit !== false && Model.modelName !== 'AuditLog';
  }

  /** Build the always-clinic-scoped filter, optionally excluding soft-deleted docs. */
  scopedFilter(filter = {}, { includeDeleted = false } = {}) {
    const scoped = { ...filter, clinicId: this.ctx.clinicId };
    if (this.isSoftDeletable && !includeDeleted && !('deletedAt' in scoped)) {
      scoped.deletedAt = null;
    }
    return scoped;
  }

  // ---- Reads -------------------------------------------------------------

  find(filter = {}, opts = {}) {
    const { includeDeleted, sort, limit, skip, projection, lean = false } = opts;
    let q = this.Model.find(this.scopedFilter(filter, { includeDeleted }), projection);
    if (sort) q = q.sort(sort);
    if (typeof skip === 'number') q = q.skip(skip);
    if (typeof limit === 'number') q = q.limit(limit);
    if (lean) q = q.lean();
    return q.exec();
  }

  findOne(filter = {}, opts = {}) {
    const { includeDeleted, projection, lean = false } = opts;
    let q = this.Model.findOne(this.scopedFilter(filter, { includeDeleted }), projection);
    if (lean) q = q.lean();
    return q.exec();
  }

  findById(id, opts = {}) {
    return this.findOne({ _id: id }, opts);
  }

  count(filter = {}, opts = {}) {
    const { includeDeleted } = opts;
    return this.Model.countDocuments(this.scopedFilter(filter, { includeDeleted })).exec();
  }

  // ---- Writes ------------------------------------------------------------

  async create(data) {
    const doc = await this.Model.create({
      ...sanitizeInput(data),
      clinicId: this.ctx.clinicId, // always the request's clinic — never trust input
    });
    await this._audit('create', doc._id, null, doc.toObject());
    return doc;
  }

  /**
   * Update a document by id (within the clinic, not soft-deleted).
   * Captures before/after snapshots for the audit log.
   */
  async updateById(id, update, opts = {}) {
    const existing = await this.Model.findOne(
      this.scopedFilter({ _id: id }, { includeDeleted: opts.includeDeleted })
    );
    if (!existing) return null;

    const before = existing.toObject();
    existing.set(sanitizeInput(update));
    if (!existing.isModified()) {
      // No-op update (empty body, or values equal to current): nothing actually
      // changed, so don't write a phantom 'update' audit entry (before === after).
      return existing;
    }
    const saved = await existing.save();
    await this._audit('update', saved._id, before, saved.toObject());
    return saved;
  }

  /**
   * Soft delete (hard rule 6): never removes the row, sets deletedAt/deletedBy
   * and writes an audit entry. Throws for models that are not soft-deletable
   * rather than silently hard-deleting clinical/financial data.
   */
  async softDeleteById(id) {
    if (!this.isSoftDeletable) {
      throw new AppError(
        500,
        `${this.entityType} is not soft-deletable; refusing to hard-delete (hard rule 6)`
      );
    }
    const existing = await this.Model.findOne(this.scopedFilter({ _id: id }));
    if (!existing) return null;

    const before = existing.toObject();
    existing.deletedAt = new Date();
    existing.deletedBy = this.ctx.actorId || null;
    const saved = await existing.save();
    await this._audit('delete', saved._id, before, saved.toObject());
    return saved;
  }

  /**
   * Record that a record was viewed (hard rule 7 mentions report views).
   * Optional, for sensitive reads; not called on routine list/get by default.
   */
  recordRead(entityId, snapshot = null) {
    return this._audit('read', entityId, null, snapshot);
  }

  // ---- Internal ----------------------------------------------------------

  async _audit(action, entityId, before, after) {
    if (!this.auditEnabled) return;
    await AuditLog.create({
      clinicId: this.ctx.clinicId,
      actorId: this.ctx.actorId || null,
      actorRole: this.ctx.actorRole || null,
      action,
      entityType: this.entityType,
      entityId,
      ...(before !== null && before !== undefined ? { before } : {}),
      ...(after !== null && after !== undefined ? { after } : {}),
    });
  }
}

function tenantRepo(Model, ctx, options) {
  return new TenantRepository(Model, ctx, options);
}

module.exports = { TenantRepository, tenantRepo };
