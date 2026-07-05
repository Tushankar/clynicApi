'use strict';

const { Supplier } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const AppError = require('../utils/AppError');

/**
 * Pharmacy suppliers/distributors (Ultra Premium, §6.1). Clinic-wide vendor records; CRUD via the
 * audited tenant repo (hard rules 6, 7). Referenced by purchase orders.
 */
function repo(ctx) {
  return tenantRepo(Supplier, ctx);
}
const trimTo = (v, max) => (v === undefined || v === null ? undefined : String(v).trim().slice(0, max));

async function list(ctx, { search, active } = {}) {
  const filter = {};
  if (active === 'true' || active === true) filter.active = true;
  if (active === 'false' || active === false) filter.active = false;
  if (search && String(search).trim()) {
    const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    filter.$or = [{ name: rx }, { contactPerson: rx }, { phone: rx }, { gstNumber: rx }];
  }
  const items = await repo(ctx).find(filter, { sort: { name: 1 }, limit: 500, lean: true });
  return { items };
}

async function get(ctx, id) {
  const s = await repo(ctx).findById(id, { lean: true });
  if (!s) throw new AppError(404, 'Supplier not found');
  return s;
}

async function create(ctx, body = {}) {
  const name = trimTo(body.name, 200);
  if (!name) throw new AppError(400, 'Supplier name is required');
  return repo(ctx).create({
    name,
    contactPerson: trimTo(body.contactPerson, 120),
    phone: trimTo(body.phone, 30),
    email: trimTo(body.email, 200),
    gstNumber: trimTo(body.gstNumber, 30),
    address: trimTo(body.address, 500),
    notes: trimTo(body.notes, 1000),
    active: body.active === undefined ? true : !!body.active,
    createdBy: ctx.actorId || null,
  });
}

async function update(ctx, id, body = {}) {
  const existing = await repo(ctx).findById(id);
  if (!existing) throw new AppError(404, 'Supplier not found');
  const update = {};
  const setStr = (k, max) => { if (body[k] !== undefined) update[k] = String(body[k] || '').trim().slice(0, max); };
  setStr('name', 200);
  if ('name' in update && update.name === '') throw new AppError(400, 'Name cannot be empty');
  setStr('contactPerson', 120);
  setStr('phone', 30);
  setStr('email', 200);
  setStr('gstNumber', 30);
  setStr('address', 500);
  setStr('notes', 1000);
  if (body.active !== undefined) update.active = !!body.active;
  return repo(ctx).updateById(id, update);
}

async function remove(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Supplier not found');
  return deleted;
}

module.exports = { list, get, create, update, remove };
