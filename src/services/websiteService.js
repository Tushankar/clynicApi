'use strict';

const { Clinic, Doctor } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Public website + tiered CMS (§5.19 / 8.6). Platform-hosted only (no custom domains).
 *
 * TENANT ISOLATION (critical): every public read resolves ONE clinic by its unique slug and
 * returns only that clinic's data — doctors are fetched with a clinicId-scoped repo, so a
 * public request can never surface another clinic's data. CMS writes go through the audited,
 * clinic-scoped tenant repo (req.ctx.clinicId), so a clinic can only edit its own site.
 */

const TEMPLATES = Clinic.TEMPLATES || ['clean-clinical', 'warm-family', 'modern-specialist'];
const DEFAULT_PRIMARY = '#0d9488'; // calm medical teal (§8.5 tokens)
const DEFAULT_ACCENT = '#0f766e';

// ---- input guards ----
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampArr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
const imageUrl = (v) => { const s = str(v, 600); return /^https?:\/\/[^\s]+$/i.test(s) ? s : ''; };
const httpsUrl = (v) => { const s = str(v, 800); return /^https:\/\/[^\s]+$/i.test(s) ? s : ''; };
const hexColor = (v) => { const s = str(v, 9); return /^#[0-9a-f]{3,8}$/i.test(s) ? s : ''; };
const slugify = (v) => str(v, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

// ---- public render (with graceful, profile-derived defaults so nothing is ever empty) ----
function deriveServices(doctors) {
  const specs = [...new Set(doctors.map((d) => d.specialization).filter(Boolean))];
  const list = specs.length ? specs : ['General Consultation'];
  return list.map((name) => ({ name, description: `Expert ${name.toLowerCase()} care with online booking.`, icon: '' }));
}

function buildSite(clinic, doctors) {
  const w = clinic.website || {};
  const c = w.content || {};
  const t = w.theme || {};
  const hero = c.hero || {};
  const logoUrl = t.logoUrl || clinic.logoUrl || '';
  return {
    clinic: { name: clinic.name, slug: clinic.slug, phone: clinic.phone || '', address: clinic.address || '' },
    template: TEMPLATES.includes(w.template) ? w.template : 'clean-clinical',
    theme: { primaryColor: hexColor(t.primaryColor) || DEFAULT_PRIMARY, accentColor: hexColor(t.accentColor) || DEFAULT_ACCENT, logoUrl },
    content: {
      hero: {
        headline: str(hero.headline, 160) || clinic.name,
        tagline: str(hero.tagline, 240) || 'Trusted, modern healthcare — book your visit online in seconds.',
        imageUrl: imageUrl(hero.imageUrl),
      },
      about: str(c.about, 4000) || `${clinic.name} is dedicated to compassionate, patient-first care. Our team combines experience with a warm, modern clinic experience — and you can book online anytime.`,
      services: (Array.isArray(c.services) && c.services.length ? c.services.map((s) => ({ name: str(s.name, 120), description: str(s.description, 400), icon: str(s.icon, 40) })).filter((s) => s.name) : deriveServices(doctors)),
      gallery: (c.gallery || []).map(imageUrl).filter(Boolean),
      contact: {
        phone: str(c.contact?.phone, 40) || clinic.phone || '',
        email: str(c.contact?.email, 160),
        whatsapp: str(c.contact?.whatsapp, 40),
        address: str(c.contact?.address, 300) || clinic.address || '',
      },
      mapEmbed: httpsUrl(c.mapEmbed),
    },
    doctors: doctors.map((d) => ({ id: String(d._id), name: d.name, specialization: d.specialization || 'General Physician', consultationFee: d.consultationFee || 0 })),
    reviews: (w.reviews || []).filter((r) => r.approved).map((r) => ({ name: str(r.name, 120) || 'Patient', text: str(r.text, 800), rating: Math.max(1, Math.min(5, Number(r.rating) || 5)) })),
    pages: (w.pages || []).filter((p) => p.published).map((p) => ({ slug: p.slug, title: str(p.title, 160), body: str(p.body, 20000) })),
    seo: {
      title: str(w.seo?.title, 160) || `${clinic.name} — Book an appointment online`,
      description: str(w.seo?.description, 320) || `Book an appointment at ${clinic.name}. ${(doctors[0] && `See ${doctors[0].name}`) || 'Trusted local care'}.`,
      keywords: str(w.seo?.keywords, 300),
    },
  };
}

/** Public site config for one slug. Returns { available:false } if missing/unpublished. */
async function getPublicSite(slug) {
  if (!slug) return { available: false };
  const clinic = await Clinic.findOne({ slug }).lean(); // globally unique slug → one clinic
  if (!clinic) return { available: false };
  if (clinic.website && clinic.website.published === false) return { available: false, reason: 'unpublished' };
  const ctx = { clinicId: clinic.clinicId, actorId: 'public', actorRole: null };
  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { sort: { name: 1 }, lean: true }); // clinic-scoped
  return { available: true, site: buildSite(clinic, doctors) };
}

/** Doctors + clinic basics for the /book page. Clinic-scoped by the resolved slug. */
async function getBookingData(slug) {
  if (!slug) throw new AppError(404, 'Clinic not found');
  const clinic = await Clinic.findOne({ slug }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const ctx = { clinicId: clinic.clinicId, actorId: 'public', actorRole: null };
  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { sort: { name: 1 }, lean: true });
  return {
    clinic: { name: clinic.name, slug: clinic.slug, phone: clinic.phone || '', address: clinic.address || '' },
    doctors: doctors.map((d) => ({ id: String(d._id), name: d.name, specialization: d.specialization, consultationFee: d.consultationFee || 0 })),
  };
}

// ---- CMS (auth + plan-gated; clinic-scoped via req.ctx) ----
function repo(ctx) {
  return tenantRepo(Clinic, ctx); // audited (hard rule 7)
}
async function loadClinic(ctx) {
  const clinic = await repo(ctx).findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');
  return clinic;
}

/** Full editable site config for the dashboard CMS. */
async function getSiteConfig(ctx) {
  const clinic = await loadClinic(ctx);
  const w = clinic.website || {};
  return {
    slug: clinic.slug,
    published: w.published !== false,
    template: w.template || 'clean-clinical',
    templates: TEMPLATES,
    theme: w.theme || {},
    content: w.content || {},
    reviews: w.reviews || [],
    pages: w.pages || [],
    seo: w.seo || {},
    publicUrl: `${config.publicSiteBaseUrl}/c/${clinic.slug}`,
  };
}

function sanitizeContent(input = {}) {
  const c = input || {};
  return {
    hero: { headline: str(c.hero?.headline, 160), tagline: str(c.hero?.tagline, 240), imageUrl: imageUrl(c.hero?.imageUrl) },
    about: str(c.about, 4000),
    services: clampArr(c.services, 24).map((s) => ({ name: str(s.name, 120), description: str(s.description, 400), icon: str(s.icon, 40) })).filter((s) => s.name),
    gallery: clampArr(c.gallery, 24).map(imageUrl).filter(Boolean),
    contact: { phone: str(c.contact?.phone, 40), email: str(c.contact?.email, 160), whatsapp: str(c.contact?.whatsapp, 40), address: str(c.contact?.address, 300) },
    mapEmbed: httpsUrl(c.mapEmbed),
  };
}

async function updateContent(ctx, content) {
  const clinic = await loadClinic(ctx);
  await repo(ctx).updateById(clinic._id, { 'website.content': sanitizeContent(content) });
  return getSiteConfig(ctx);
}

async function updateTheme(ctx, { template, theme } = {}) {
  const clinic = await loadClinic(ctx);
  const patch = {};
  if (template !== undefined) {
    if (!TEMPLATES.includes(template)) throw new AppError(400, 'Unknown template');
    patch.template = template;
  }
  if (theme !== undefined) {
    patch.theme = { primaryColor: hexColor(theme.primaryColor), accentColor: hexColor(theme.accentColor), logoUrl: imageUrl(theme.logoUrl) };
  }
  await repo(ctx).updateById(clinic._id, Object.fromEntries(Object.entries(patch).map(([k, v]) => [`website.${k}`, v])));
  return getSiteConfig(ctx);
}

async function setPublished(ctx, published) {
  const clinic = await loadClinic(ctx);
  await repo(ctx).updateById(clinic._id, { 'website.published': !!published });
  return getSiteConfig(ctx);
}

// --- Pages (CMS_ADVANCED) ---
function sanitizePage(p = {}) {
  return { slug: slugify(p.slug) || slugify(p.title), title: str(p.title, 160), body: str(p.body, 20000), published: !!p.published };
}
async function listPages(ctx) {
  return (await loadClinic(ctx)).website?.pages || [];
}
async function createPage(ctx, page) {
  const clinic = await loadClinic(ctx);
  const clean = sanitizePage(page);
  if (!clean.slug) throw new AppError(400, 'Page needs a title/slug');
  const pages = clinic.website?.pages || [];
  if (pages.some((p) => p.slug === clean.slug)) throw new AppError(409, 'A page with that slug already exists');
  await repo(ctx).updateById(clinic._id, { 'website.pages': [...pages, clean] });
  return getSiteConfig(ctx);
}
async function updatePage(ctx, pageSlug, patch) {
  const clinic = await loadClinic(ctx);
  const pages = clinic.website?.pages || [];
  const idx = pages.findIndex((p) => p.slug === pageSlug);
  if (idx < 0) throw new AppError(404, 'Page not found');
  const merged = sanitizePage({ ...pages[idx], ...patch, slug: pages[idx].slug });
  const next = pages.slice();
  next[idx] = merged;
  await repo(ctx).updateById(clinic._id, { 'website.pages': next });
  return getSiteConfig(ctx);
}
async function deletePage(ctx, pageSlug) {
  const clinic = await loadClinic(ctx);
  const pages = (clinic.website?.pages || []).filter((p) => p.slug !== pageSlug);
  await repo(ctx).updateById(clinic._id, { 'website.pages': pages });
  return getSiteConfig(ctx);
}

// --- Reviews (CMS_ADVANCED) ---
async function getReviews(ctx) {
  return (await loadClinic(ctx)).website?.reviews || [];
}
async function updateReviews(ctx, reviews) {
  const clinic = await loadClinic(ctx);
  const clean = clampArr(reviews, 60).map((r) => ({ name: str(r.name, 120), text: str(r.text, 800), rating: Math.max(1, Math.min(5, Number(r.rating) || 5)), approved: !!r.approved })).filter((r) => r.text);
  await repo(ctx).updateById(clinic._id, { 'website.reviews': clean });
  return getSiteConfig(ctx);
}

// --- SEO (CMS_ADVANCED) ---
async function updateSeo(ctx, seo = {}) {
  const clinic = await loadClinic(ctx);
  await repo(ctx).updateById(clinic._id, { 'website.seo': { title: str(seo.title, 160), description: str(seo.description, 320), keywords: str(seo.keywords, 300) } });
  return getSiteConfig(ctx);
}

module.exports = {
  TEMPLATES,
  getPublicSite,
  getBookingData,
  getSiteConfig,
  updateContent,
  updateTheme,
  setPublished,
  listPages,
  createPage,
  updatePage,
  deletePage,
  getReviews,
  updateReviews,
  updateSeo,
};
