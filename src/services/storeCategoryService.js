'use strict';

const sharp = require('sharp');
const { MedicineCategory } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const storage = require('../lib/storage');
const AppError = require('../utils/AppError');

/**
 * Storefront category management (Ultra Premium, §6.6). Dashboard CRUD + private category image.
 * Audited soft-delete via the tenant repo. Medicines join a category by their free-text `category`
 * field matching the category name (case-insensitive) — no Medicine schema change needed.
 */
function repo(ctx) {
  return tenantRepo(MedicineCategory, ctx);
}
const trimTo = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));
const slugify = (s) => String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);

function view(ctx, c) {
  return { ...c, imageUrl: c.imageStorageKey ? storage.getSignedUrl({ clinicId: ctx.clinicId, key: c.imageStorageKey, meta: { mime: 'image/jpeg' } }).path : null };
}

async function list(ctx) {
  const items = await repo(ctx).find({}, { sort: { sortOrder: 1, name: 1 }, lean: true });
  return { items: items.map((c) => view(ctx, c)) };
}

async function create(ctx, body = {}) {
  const name = trimTo(body.name, 120);
  if (!name) throw new AppError(400, 'Category name is required');
  const slug = slugify(body.slug || name) || undefined; // undefined so the sparse partial index skips blanks
  try {
    const c = await repo(ctx).create({ name, slug, description: trimTo(body.description, 500), sortOrder: Number(body.sortOrder) || 0, active: body.active === undefined ? true : !!body.active, createdBy: ctx.actorId || null });
    return view(ctx, c.toObject());
  } catch (err) {
    if (err && err.code === 11000) throw new AppError(409, 'A category with that slug already exists');
    throw err;
  }
}

async function update(ctx, id, body = {}) {
  const existing = await repo(ctx).findById(id);
  if (!existing) throw new AppError(404, 'Category not found');
  const update = {};
  if (body.name !== undefined) { update.name = String(body.name || '').trim().slice(0, 120); if (!update.name) throw new AppError(400, 'Name cannot be empty'); }
  if (body.slug !== undefined) update.slug = slugify(body.slug) || null;
  if (body.description !== undefined) update.description = String(body.description || '').trim().slice(0, 500);
  if (body.sortOrder !== undefined) update.sortOrder = Number(body.sortOrder) || 0;
  if (body.active !== undefined) update.active = !!body.active;
  try {
    const saved = await repo(ctx).updateById(id, update);
    return view(ctx, saved.toObject());
  } catch (err) {
    if (err && err.code === 11000) throw new AppError(409, 'A category with that slug already exists');
    throw err;
  }
}

async function remove(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Category not found');
  return deleted;
}

async function uploadImage(ctx, id, file) {
  if (!file || !file.buffer?.length) throw new AppError(400, 'No image uploaded');
  if (!/^image\//.test(file.mimetype || '')) throw new AppError(400, 'File must be an image (JPG, PNG, or WebP).');
  const cat = await repo(ctx).findById(id);
  if (!cat) throw new AppError(404, 'Category not found');
  let processed;
  try {
    processed = await sharp(file.buffer).rotate().resize({ width: 640, height: 420, fit: 'cover', withoutEnlargement: false }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    throw new AppError(400, "Couldn't read that image — please try a JPG, PNG, or WebP.");
  }
  const key = `pharmacy/categories/${cat._id}.jpg`;
  await storage.saveFile({ clinicId: ctx.clinicId, key, buffer: processed, contentType: 'image/jpeg' });
  const saved = await repo(ctx).updateById(id, { imageStorageKey: key, imageStorageDriver: storage.driver });
  return view(ctx, saved.toObject());
}

module.exports = { list, create, update, remove, uploadImage };
