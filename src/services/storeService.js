'use strict';

const { Medicine, MedicineCategory, Patient } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { resolveClinic } = require('./publicService');
// Public tenant ctx: clinicId present, no real actor (same shape publicService uses internally).
const publicCtx = (clinic) => ({ clinicId: clinic.clinicId, actorId: 'public', actorRole: null });
const { planHasFeature } = require('../config/plans');
const medicineService = require('./pharmacyMedicineService');
const inventoryService = require('./pharmacyInventoryService');
const otpService = require('./otpService');
const patientService = require('./patientService');
const patientSession = require('./../lib/patientSession');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Public storefront read/browse + email-OTP auth (Ultra Premium, §6.6). Resolves ONE clinic by slug
 * and HIDES the store (404) for non-Ultra clinics — so a non-Ultra clinic's site has no store at all.
 * Exposes ONLY safe public product fields (never cost/reorder/sku/hsn). Symptom browse surfaces
 * OTC/wellness products ONLY — never prescription-required medicines by symptom (§5.4).
 */

// Resolve the clinic for a store request and enforce the Ultra gate (hide as 404, like assertAiEnabled).
async function resolveStore(slug) {
  const clinic = await resolveClinic(slug); // throws 404 if no such clinic
  if (!planHasFeature(clinic.subscriptionPlan, 'PHARMACY_STOREFRONT')) throw new AppError(404, 'Not available');
  return { clinic, ctx: publicCtx(clinic) };
}

// Public-safe projection of a medicine (never leak internal cost/stock/sku fields).
function publicMedicine(ctx, med, stock) {
  const available = stock ? stock.available || 0 : 0;
  return {
    id: String(med._id),
    name: med.name,
    brand: med.brand || '',
    composition: med.composition || '',
    category: med.category || '',
    form: med.form,
    strength: med.strength || '',
    unit: med.unit || 'unit',
    price: med.sellingPrice,
    imageUrl: medicineService.imageUrlFor(ctx, med),
    prescriptionRequired: !!med.prescriptionRequired,
    scheduleClass: med.scheduleClass || 'OTC',
    description: med.description || '',
    dosageInfo: med.dosageInfo || '',
    symptomTags: med.symptomTags || [],
    inStock: available > 0,
  };
}

// Sellable medicines only: active + priced. (Staff must set a selling price to list online.)
function sellableFilter(extra = {}) {
  return { active: { $ne: false }, sellingPrice: { $ne: null, $gt: 0 }, ...extra };
}

async function decorateList(ctx, meds) {
  const stockMap = await inventoryService.availabilityMap(ctx, { medicineIds: meds.map((m) => m._id) });
  return meds.map((m) => publicMedicine(ctx, m, stockMap[String(m._id)]));
}

function categoryView(ctx, c) {
  return {
    name: c.name,
    slug: c.slug || null,
    description: c.description || '',
    imageUrl: c.imageStorageKey ? require('../lib/storage').getSignedUrl({ clinicId: ctx.clinicId, key: c.imageStorageKey, meta: { mime: 'image/jpeg' } }).path : null,
  };
}

async function home(slug) {
  const { clinic, ctx } = await resolveStore(slug);
  const [cats, meds] = await Promise.all([
    tenantRepo(MedicineCategory, ctx, { audit: false }).find({ active: { $ne: false } }, { sort: { sortOrder: 1, name: 1 }, limit: 60, lean: true }),
    tenantRepo(Medicine, ctx, { audit: false }).find(sellableFilter(), { sort: { updatedAt: -1 }, limit: 24, lean: true }),
  ]);
  const featured = await decorateList(ctx, meds);
  // OTC/wellness symptom tags only (never Rx-by-symptom, §5.4).
  const symptomTags = [...new Set(meds.filter((m) => !m.prescriptionRequired).flatMap((m) => m.symptomTags || []))].slice(0, 20);
  return {
    store: { name: clinic.name, slug: clinic.slug, phone: clinic.phone || '', address: clinic.address || '' },
    categories: cats.map((c) => categoryView(ctx, c)),
    featured,
    symptoms: symptomTags,
  };
}

async function categories(slug) {
  const { ctx } = await resolveStore(slug);
  const cats = await tenantRepo(MedicineCategory, ctx, { audit: false }).find({ active: { $ne: false } }, { sort: { sortOrder: 1, name: 1 }, lean: true });
  return { items: cats.map((c) => categoryView(ctx, c)) };
}

async function categoryItems(slug, catSlug) {
  const { ctx } = await resolveStore(slug);
  const cat = await tenantRepo(MedicineCategory, ctx, { audit: false }).findOne({ slug: String(catSlug || '').toLowerCase() });
  if (!cat) throw new AppError(404, 'Category not found');
  // Medicines are matched to a category by their free-text `category` == category name (case-insensitive).
  const rx = new RegExp('^' + escapeRegex(cat.name) + '$', 'i');
  const meds = await tenantRepo(Medicine, ctx, { audit: false }).find(sellableFilter({ category: rx }), { sort: { name: 1 }, limit: 200, lean: true });
  return { category: categoryView(ctx, cat), items: await decorateList(ctx, meds) };
}

async function symptomItems(slug, tag) {
  const { ctx } = await resolveStore(slug);
  const clean = String(tag || '').trim().toLowerCase();
  if (!clean) return { symptom: clean, items: [] };
  // §5.4: OTC/wellness ONLY — never surface prescription-required medicines by symptom.
  const meds = await tenantRepo(Medicine, ctx, { audit: false }).find(sellableFilter({ prescriptionRequired: false, symptomTags: clean }), { sort: { name: 1 }, limit: 200, lean: true });
  return { symptom: clean, items: await decorateList(ctx, meds) };
}

async function search(slug, q) {
  const { ctx } = await resolveStore(slug);
  const term = String(q || '').trim();
  if (!term) return { items: [] };
  const rx = new RegExp(escapeRegex(term), 'i');
  const meds = await tenantRepo(Medicine, ctx, { audit: false }).find(sellableFilter({ $or: [{ name: rx }, { brand: rx }, { composition: rx }, { category: rx }] }), { sort: { name: 1 }, limit: 60, lean: true });
  return { items: await decorateList(ctx, meds) };
}

async function product(slug, medicineId) {
  const { ctx } = await resolveStore(slug);
  const med = await tenantRepo(Medicine, ctx, { audit: false }).findOne({ _id: medicineId, active: { $ne: false } });
  if (!med) throw new AppError(404, 'Medicine not found');
  const stockMap = await inventoryService.availabilityMap(ctx, { medicineIds: [med._id] });
  return publicMedicine(ctx, med.toObject(), stockMap[String(med._id)]);
}

/* --------------------------------- Email-OTP auth --------------------------------- */

async function requestOtp(slug, email) {
  const { clinic } = await resolveStore(slug);
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email).trim())) throw new AppError(400, 'A valid email is required');
  return otpService.requestOtp(clinic.clinicId, String(email).trim().toLowerCase());
}

/**
 * Verify the OTP and mint a patient session. Unlike portal login, this CREATES a patient for a
 * first-time buyer (publicBook pattern) so new customers can check out.
 */
async function verifyOtp(slug, { email, code, name } = {}) {
  const { clinic, ctx } = await resolveStore(slug);
  const contact = String(email || '').trim().toLowerCase();
  if (!contact) throw new AppError(400, 'Email is required');
  await otpService.verifyOtp(clinic.clinicId, contact, code); // throws on bad/absent code
  // Match or create the patient BEFORE consuming the code (so a failed create doesn't burn the OTP).
  const { patient } = await patientService.findOrCreatePatient(ctx, { name: String(name || '').trim() || 'Store customer', email: contact });
  await otpService.consumeVerified(clinic.clinicId, contact); // single-use
  const token = patientSession.sign({
    clinicId: clinic.clinicId,
    patientId: String(patient._id),
    email: patient.email || contact,
    exp: Date.now() + (config.patientSessionTtlHours || 24) * 3600 * 1000,
  });
  return { token, patient: { id: String(patient._id), name: patient.name, email: patient.email || contact } };
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { resolveStore, home, categories, categoryItems, symptomItems, search, product, requestOtp, verifyOtp, publicMedicine };
