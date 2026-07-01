'use strict';

const { Clinic, Doctor } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const AppError = require('../utils/AppError');

/**
 * Public website builder (§5.19). TEMPLATE-based (not freeform drag-drop): the owner edits
 * structured content, and the public site renders from it. Content lives on
 * clinics.publicPageContent. Editing is Premium (WEBSITE_BUILDER) + owner (rules 4/5);
 * the change is audited (clinic-scoped via TenantRepository, hard rules 1/7).
 */

const DEFAULT_CONTENT = {
  published: false,
  headline: '',
  about: '',
  services: [], // [{ name, description }]
  gallery: [], // [imageUrl]
  reviews: [], // [{ author, rating, text }]
  hours: '', // free text, e.g. "Mon–Sat 10am–7pm"
  contact: { phone: '', email: '', whatsapp: '', mapUrl: '' },
};

const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampArr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);

/** Keep only known fields + bounded sizes so the stored blob can't be abused. */
function sanitizeContent(input = {}) {
  const c = input || {};
  return {
    published: !!c.published,
    headline: str(c.headline, 160),
    about: str(c.about, 4000),
    services: clampArr(c.services, 30).map((s) => ({ name: str(s.name, 120), description: str(s.description, 500) })).filter((s) => s.name),
    gallery: clampArr(c.gallery, 24).map((u) => str(u, 500)).filter(Boolean),
    reviews: clampArr(c.reviews, 30).map((r) => ({ author: str(r.author, 120), rating: Math.max(1, Math.min(5, Number(r.rating) || 5)), text: str(r.text, 800) })).filter((r) => r.text),
    hours: str(c.hours, 500),
    contact: {
      phone: str(c.contact?.phone, 40),
      email: str(c.contact?.email, 160),
      whatsapp: str(c.contact?.whatsapp, 40),
      mapUrl: str(c.contact?.mapUrl, 600),
    },
  };
}

async function getContent(ctx) {
  const clinic = await tenantRepo(Clinic, ctx).findOne({});
  return { ...DEFAULT_CONTENT, ...(clinic?.publicPageContent || {}) };
}

async function updateContent(ctx, content) {
  const repo = tenantRepo(Clinic, ctx);
  const clinic = await repo.findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const clean = sanitizeContent(content);
  await repo.updateById(clinic._id, { publicPageContent: clean }); // audited
  return clean;
}

/**
 * Public render payload (no auth; clinic resolved from slug). Returns the site only if the
 * clinic's plan includes WEBSITE_BUILDER AND the owner has published it; otherwise the
 * caller falls back to the plain booking page. Doctors are pulled live (source of truth).
 */
async function getPublicSite(slug) {
  const clinic = await Clinic.findOne({ slug: String(slug || '').toLowerCase().trim() }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const content = { ...DEFAULT_CONTENT, ...(clinic.publicPageContent || {}) };
  const enabled = planHasFeature(clinic.subscriptionPlan, 'WEBSITE_BUILDER') && content.published;
  if (!enabled) return { available: false, slug: clinic.slug };

  const ctx = { clinicId: clinic.clinicId, actorId: 'public', actorRole: null };
  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { sort: { name: 1 }, lean: true });
  return {
    available: true,
    clinic: { name: clinic.name, slug: clinic.slug, logoUrl: clinic.logoUrl, address: clinic.address, phone: clinic.phone },
    doctors: doctors.map((d) => ({ name: d.name, specialization: d.specialization, consultationFee: d.consultationFee })),
    content,
  };
}

module.exports = { getContent, updateContent, getPublicSite, DEFAULT_CONTENT };
