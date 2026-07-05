'use strict';

const sharp = require('sharp');
const { Medicine } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const storage = require('../lib/storage');
const inventoryService = require('./pharmacyInventoryService');
const alertService = require('./pharmacyAlertService');
const AppError = require('../utils/AppError');

/**
 * Pharmacy medicine catalog (Ultra Premium, §6.2). Clinic-wide product definitions with a
 * private catalog image (hard rule 3: opaque storage key + short-lived signed URL, never a
 * public URL). Catalog is a commercial record → audited soft-delete via the tenant repo.
 * List/get responses are decorated with live availability from the inventory service.
 */
function repo(ctx) {
  return tenantRepo(Medicine, ctx); // audited (catalog / commercial)
}

const trimTo = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));
function clampNum(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

/** Short-lived signed URL for a medicine's private image (or null). Never throws. */
function imageUrlFor(ctx, med) {
  if (!med || !med.imageStorageKey) return null;
  try {
    return storage.getSignedUrl({ clinicId: ctx.clinicId, key: med.imageStorageKey, meta: { mime: 'image/jpeg' } }).path;
  } catch {
    return null;
  }
}

function decorate(ctx, med, stock) {
  const s = stock || {};
  const available = s.available || 0;
  return {
    ...med,
    imageUrl: imageUrlFor(ctx, med),
    available,
    batchCount: s.batchCount || 0,
    expiringSoonQty: s.expiringSoonQty || 0,
    expiredQty: s.expiredQty || 0,
    nearestExpiry: s.nearestExpiry || null,
    lowStock: med.reorderLevel > 0 && available <= med.reorderLevel,
  };
}

async function list(ctx, { search, category, active } = {}) {
  const filter = {};
  if (typeof category === 'string') filter.category = category; // literal string only (no operator objects)
  if (active === 'true' || active === true) filter.active = true;
  if (active === 'false' || active === false) filter.active = false;
  if (search && String(search).trim()) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { brand: rx }, { composition: rx }, { sku: rx }];
  }
  const meds = await repo(ctx).find(filter, { sort: { name: 1 }, limit: 500, lean: true });
  const stockMap = await inventoryService.availabilityMap(ctx, { medicineIds: meds.map((m) => m._id) });
  return { items: meds.map((m) => decorate(ctx, m, stockMap[String(m._id)])) };
}

async function get(ctx, id) {
  const med = await repo(ctx).findById(id, { lean: true });
  if (!med) throw new AppError(404, 'Medicine not found');
  const stockMap = await inventoryService.availabilityMap(ctx, { medicineIds: [med._id] });
  return decorate(ctx, med, stockMap[String(med._id)]);
}

function normalizeCompliance(target) {
  // Schedule H/H1/X ALWAYS require a prescription (§12). Never let a permissive flag through.
  if (['H', 'H1', 'X'].includes(target.scheduleClass)) target.prescriptionRequired = true;
}

async function create(ctx, body = {}) {
  const name = trimTo(body.name, 200);
  if (!name) throw new AppError(400, 'A medicine name is required');
  const doc = {
    name,
    brand: trimTo(body.brand, 200),
    composition: trimTo(body.composition, 300),
    category: trimTo(body.category, 120),
    form: Medicine.FORMS.includes(body.form) ? body.form : 'other',
    strength: trimTo(body.strength, 60),
    unit: Medicine.UNITS.includes(body.unit) ? body.unit : 'unit',
    sku: trimTo(body.sku, 60) || undefined, // undefined so the sparse unique index skips blanks
    hsnCode: trimTo(body.hsnCode, 20),
    gstRate: clampNum(body.gstRate, 0, 100, 0),
    sellingPrice: body.sellingPrice === '' || body.sellingPrice == null ? null : Math.max(0, Number(body.sellingPrice) || 0),
    reorderLevel: Math.max(0, Math.floor(Number(body.reorderLevel) || 0)),
    prescriptionRequired: !!body.prescriptionRequired,
    scheduleClass: Medicine.SCHEDULE_CLASSES.includes(body.scheduleClass) ? body.scheduleClass : 'OTC',
    description: trimTo(body.description, 2000),
    dosageInfo: trimTo(body.dosageInfo, 1000),
    active: body.active === undefined ? true : !!body.active,
    createdBy: ctx.actorId || null,
  };
  normalizeCompliance(doc);
  try {
    const created = await repo(ctx).create(doc);
    return decorate(ctx, created.toObject(), null);
  } catch (err) {
    if (err && err.code === 11000) throw new AppError(409, 'A medicine with that SKU already exists');
    throw err;
  }
}

async function update(ctx, id, body = {}) {
  const existing = await repo(ctx).findById(id);
  if (!existing) throw new AppError(404, 'Medicine not found');
  const update = {};
  const setStr = (k, max) => { if (body[k] !== undefined) update[k] = String(body[k] || '').trim().slice(0, max); };
  setStr('name', 200);
  if ('name' in update && update.name === '') throw new AppError(400, 'Name cannot be empty');
  setStr('brand', 200);
  setStr('composition', 300);
  setStr('category', 120);
  setStr('strength', 60);
  setStr('hsnCode', 20);
  setStr('description', 2000);
  setStr('dosageInfo', 1000);
  if (body.form !== undefined) update.form = Medicine.FORMS.includes(body.form) ? body.form : 'other';
  if (body.unit !== undefined) update.unit = Medicine.UNITS.includes(body.unit) ? body.unit : 'unit';
  if (body.sku !== undefined) update.sku = String(body.sku || '').trim().slice(0, 60) || null;
  if (body.gstRate !== undefined) update.gstRate = clampNum(body.gstRate, 0, 100, 0);
  if (body.sellingPrice !== undefined) update.sellingPrice = body.sellingPrice === '' || body.sellingPrice === null ? null : Math.max(0, Number(body.sellingPrice) || 0);
  if (body.reorderLevel !== undefined) update.reorderLevel = Math.max(0, Math.floor(Number(body.reorderLevel) || 0));
  if (body.prescriptionRequired !== undefined) update.prescriptionRequired = !!body.prescriptionRequired;
  if (body.scheduleClass !== undefined) update.scheduleClass = Medicine.SCHEDULE_CLASSES.includes(body.scheduleClass) ? body.scheduleClass : 'OTC';
  if (body.active !== undefined) update.active = !!body.active;
  // Effective schedule after the update decides the Rx requirement (compliance).
  const effectiveSchedule = update.scheduleClass !== undefined ? update.scheduleClass : existing.scheduleClass;
  if (['H', 'H1', 'X'].includes(effectiveSchedule)) update.prescriptionRequired = true;

  try {
    await repo(ctx).updateById(id, update);
  } catch (err) {
    if (err && err.code === 11000) throw new AppError(409, 'A medicine with that SKU already exists');
    throw err;
  }
  // A raised reorder level can push a medicine below threshold → re-check alerts.
  if (update.reorderLevel !== undefined) alertService.checkMedicine(ctx, id).catch(() => {});
  return get(ctx, id);
}

async function remove(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Medicine not found');
  return deleted;
}

/**
 * Upload / replace a medicine's catalog image. Normalized to a compact JPEG and stored
 * privately; we persist the storage KEY (not a URL) per hard rule 3.
 */
async function uploadImage(ctx, id, file) {
  if (!file || !file.buffer?.length) throw new AppError(400, 'No image uploaded');
  if (!/^image\//.test(file.mimetype || '')) throw new AppError(400, 'File must be an image (JPG, PNG, or WebP).');
  const med = await repo(ctx).findById(id);
  if (!med) throw new AppError(404, 'Medicine not found');
  let processed;
  try {
    processed = await sharp(file.buffer)
      .rotate()
      .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AppError(400, "Couldn't read that image — please try a JPG, PNG, or WebP.");
  }
  const key = `pharmacy/medicines/${med._id}.jpg`;
  await storage.saveFile({ clinicId: ctx.clinicId, key, buffer: processed, contentType: 'image/jpeg' });
  await repo(ctx).updateById(id, { imageStorageKey: key, imageStorageDriver: storage.driver });
  return get(ctx, id);
}

module.exports = {
  list,
  get,
  create,
  update,
  remove,
  uploadImage,
  imageUrlFor,
  FORMS: Medicine.FORMS,
  UNITS: Medicine.UNITS,
  SCHEDULE_CLASSES: Medicine.SCHEDULE_CLASSES,
};
