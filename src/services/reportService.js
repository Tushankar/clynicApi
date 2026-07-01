'use strict';

const crypto = require('crypto');
const path = require('path');
const { Report, Patient } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const storage = require('../lib/storage');
const signing = require('../lib/signing');
const branchService = require('./branchService');
const notificationService = require('./notificationService');
const config = require('../config/env');
const AppError = require('../utils/AppError');

function repo(ctx) {
  return tenantRepo(Report, ctx); // audited (clinical) — hard rule 7
}

function safeName(name) {
  return path.basename(String(name || 'file'))
    .replace(/[^\w.\-]+/g, '_')
    .slice(0, 120);
}

/** Store an uploaded file in PRIVATE storage and record the report (no public URL). */
async function upload(ctx, { patientId, type, title, file }) {
  if (!patientId) throw new AppError(400, 'patientId is required');
  if (!file || !file.buffer) throw new AppError(400, 'A file is required');
  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');

  const key = `${crypto.randomUUID()}-${safeName(file.originalname)}`;
  await storage.put({ clinicId: ctx.clinicId, key, buffer: file.buffer, contentType: file.mimetype });

  const cleanName = safeName(file.originalname);
  const branch = await branchService.getOrCreatePrimaryBranch(ctx);
  const report = await repo(ctx).create({
    patientId,
    type: type || 'other',
    title: title || cleanName,
    storageDriver: storage.driver,
    storageKey: key,
    originalName: cleanName, // sanitized — control chars can never reach a response header
    mimeType: file.mimetype,
    size: file.size,
    branchId: branch._id,
    uploadedByStaffId: ctx.actorId,
  });

  notificationService
    .emit(ctx, { type: 'lab_report_uploaded', message: `Report uploaded for ${patient.name}`, link: `/patients/${patientId}` })
    .catch(() => {});
  return report;
}

function list(ctx, { patientId } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  return repo(ctx).find(filter, { sort: { createdAt: -1 }, lean: true });
}

/** Issue a SHORT-LIVED signed path for one report. The bytes are never public. */
async function getSignedUrl(ctx, reportId) {
  const report = await repo(ctx).findById(reportId);
  if (!report) throw new AppError(404, 'Report not found');
  const token = signing.sign({
    rid: String(report._id),
    cid: ctx.clinicId,
    aid: ctx.actorId,
    rl: ctx.actorRole,
    exp: Date.now() + config.fileUrlTtlSeconds * 1000,
  });
  return {
    path: `/api/files/report/${report._id}?t=${encodeURIComponent(token)}`,
    expiresInSeconds: config.fileUrlTtlSeconds,
    filename: report.originalName,
    mimeType: report.mimeType,
  };
}

/**
 * Validate a signed token and return the report + a readable byte stream.
 * Writes a "report viewed" audit entry (hard rules 3 + 7). Used by the public,
 * signature-authenticated bytes route — there is NO Clerk session here.
 */
async function streamReport(token, urlReportId) {
  const data = signing.verify(token);
  if (!data) throw new AppError(401, 'Invalid or expired link');
  if (String(data.rid) !== String(urlReportId)) throw new AppError(401, 'Link does not match this report');

  const ctx = { clinicId: data.cid, actorId: data.aid, actorRole: data.rl };
  const r = repo(ctx); // tenant-scoped by the clinicId baked into the signed token
  const report = await r.findById(data.rid);
  if (!report) throw new AppError(404, 'Report not found');

  const stream = await storage.createReadStream({ clinicId: report.clinicId, key: report.storageKey });
  // Only audit a view that will actually deliver bytes: wait for the stream to open
  // (fs) / become readable (generic). A missing/unreadable file rejects (404) and
  // writes NO "report viewed" entry, keeping the compliance log truthful.
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off('open', onOpen);
      stream.off('readable', onReadable);
      stream.off('error', onError);
    };
    function onOpen() {
      cleanup();
      resolve();
    }
    function onReadable() {
      cleanup();
      resolve();
    }
    function onError() {
      cleanup();
      reject(new AppError(404, 'Report file unavailable'));
    }
    stream.once('open', onOpen);
    stream.once('readable', onReadable);
    stream.once('error', onError);
  });
  await r.recordRead(report._id); // "report viewed" audit — only after delivery is assured
  return { report, stream };
}

async function softDelete(ctx, id) {
  // Soft delete keeps the bytes (data retention); the row is excluded from default
  // queries so no new signed URL can be issued for it.
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Report not found');
  return deleted;
}

module.exports = { upload, list, getSignedUrl, streamReport, softDelete };
