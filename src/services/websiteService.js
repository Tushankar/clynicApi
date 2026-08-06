'use strict';

const sharp = require('sharp');
const { Clinic, Doctor } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const storage = require('../lib/storage');
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

const TEMPLATES = Clinic.TEMPLATES || ['premium-signature', 'clean-clinical', 'warm-family', 'modern-specialist'];
const DEFAULT_PRIMARY = '#0d9488'; // calm medical teal (§8.5 tokens)
const DEFAULT_ACCENT = '#0f766e';

// ---- input guards ----
const str = (v, max = 2000) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const clampArr = (a, n) => (Array.isArray(a) ? a.slice(0, n) : []);
const httpsUrl = (v) => { const s = str(v, 800); return /^https:\/\/[^\s]+$/i.test(s) ? s : ''; };
const hexColor = (v) => { const s = str(v, 9); return /^#[0-9a-f]{3,8}$/i.test(s) ? s : ''; };
const slugify = (v) => str(v, 60).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Image references (hard rule 3: uploaded bytes are PRIVATE, we persist keys — never URLs).
 * A stored reference is one of two forms, so owners can either upload a file or paste a link
 * and both live in the same ordered list:
 *   "upload:<storage key>"  — bytes we hold; resolved to a short-lived signed URL per request
 *   "https://…"             — an image the clinic hosts elsewhere
 * Anything else (data:, javascript:, relative paths) is rejected at the boundary.
 */
const UPLOAD_PREFIX = 'upload:';
/**
 * SECURITY: refs round-trip through the client (the CMS PUTs `content` back verbatim), so an
 * `upload:` key is UNTRUSTED input. Only keys inside this service's own namespace — exactly the
 * shape uploadImage() mints — are honoured. Without this an owner could point their PUBLIC
 * gallery at any other private key in their clinic (a patient report, a prescription PDF) and
 * we would happily mint a signed URL for it.
 */
const WEBSITE_KEY = /^website\/[a-f0-9]{1,32}\/(gallery|hero|logo)-[a-z0-9]{1,32}\.jpg$/;
const uploadKeyOf = (v) => {
  if (typeof v !== 'string' || !v.startsWith(UPLOAD_PREFIX)) return '';
  const key = v.slice(UPLOAD_PREFIX.length);
  return WEBSITE_KEY.test(key) ? key : '';
};
/** Accept-and-store guard for an image reference (upload key or absolute http(s) URL). */
const imageRef = (v) => {
  const s = str(v, 600);
  if (uploadKeyOf(s)) return s;
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
};
/** Back-compat alias: older call sites named this `imageUrl`. */
const imageUrl = imageRef;
/**
 * Turn a stored reference into something a browser can actually load. Uploads resolve to the
 * ABSOLUTE signed URL (`.url`, built from API_BASE_URL) — the public site is served from a
 * different origin than the API, so a relative path would 404 in an <img>.
 */
function resolveImage(clinicId, ref) {
  const s = str(ref, 600);
  const key = uploadKeyOf(s);
  if (key) {
    try {
      return storage.getSignedUrl({ clinicId, key, meta: { mime: 'image/jpeg' } }).url;
    } catch {
      return ''; // a stale key must never break the page render
    }
  }
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
}

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
  const img = (ref) => resolveImage(clinic.clinicId, ref); // upload key → signed URL, else http(s)
  const logoUrl = img(t.logoUrl) || img(clinic.logoUrl) || ''; // no data:/javascript: ever
  return {
    clinic: { name: clinic.name, slug: clinic.slug, phone: clinic.phone || '', address: clinic.address || '' },
    // Ultra-Premium online store availability (§6.6). ADDITIVE boolean flag only (mirrors the `ai:`
    // flag pattern) — non-Ultra clinics get `false` and an otherwise byte-for-byte-identical payload.
    store: planHasFeature(clinic.subscriptionPlan, 'PHARMACY_STOREFRONT'),
    template: TEMPLATES.includes(w.template) ? w.template : 'premium-signature',
    theme: { primaryColor: hexColor(t.primaryColor) || DEFAULT_PRIMARY, accentColor: hexColor(t.accentColor) || DEFAULT_ACCENT, logoUrl },
    content: {
      hero: {
        headline: str(hero.headline, 160) || clinic.name,
        tagline: str(hero.tagline, 240) || 'Trusted, modern healthcare — book your visit online in seconds.',
        imageUrl: img(hero.imageUrl),
      },
      about: str(c.about, 4000) || `${clinic.name} is dedicated to compassionate, patient-first care. Our team combines experience with a warm, modern clinic experience — and you can book online anytime.`,
      services: (Array.isArray(c.services) && c.services.length ? c.services.map((s) => ({ name: str(s.name, 120), description: str(s.description, 400), icon: str(s.icon, 40) })).filter((s) => s.name) : deriveServices(doctors)),
      gallery: (c.gallery || []).map(img).filter(Boolean),
      contact: {
        phone: str(c.contact?.phone, 40) || clinic.phone || '',
        email: str(c.contact?.email, 160),
        whatsapp: str(c.contact?.whatsapp, 40),
        address: str(c.contact?.address, 300) || clinic.address || '',
      },
      mapEmbed: httpsUrl(c.mapEmbed),
    },
    doctors: doctors.map((d) => ({
      id: String(d._id),
      name: d.name,
      specialization: d.specialization || 'General Physician',
      consultationFee: d.consultationFee || 0,
      // Public profile (trust/marketing) — all optional; the template degrades gracefully.
      photoUrl: imageUrl(d.photoUrl),
      qualifications: str(d.qualifications, 160),
      experienceYears: Number(d.experienceYears) || 0,
      bio: str(d.bio, 600),
      services: clampArr(d.services, 12).map((s) => str(s, 60)).filter(Boolean),
      languages: clampArr(d.languages, 8).map((s) => str(s, 40)).filter(Boolean),
    })),
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

/**
 * Full editable site config for the dashboard CMS.
 *
 * `content`/`theme` carry the STORED refs (what a save round-trips), while `media` carries
 * browser-loadable preview URLs for the same values — so the editor can show real thumbnails
 * for uploaded images without the client needing to know about signed URLs.
 */
async function getSiteConfig(ctx) {
  const clinic = await loadClinic(ctx);
  const w = clinic.website || {};
  const content = w.content || {};
  const theme = w.theme || {};
  const img = (ref) => resolveImage(clinic.clinicId, ref);
  return {
    slug: clinic.slug,
    published: w.published !== false,
    template: w.template || 'premium-signature',
    templates: TEMPLATES,
    theme,
    content,
    media: {
      logoUrl: img(theme.logoUrl),
      heroUrl: img(content.hero?.imageUrl),
      // One ordered list; each entry says whether it is an upload we host or an external link.
      gallery: (content.gallery || []).map((ref, i) => ({
        index: i,
        ref,
        url: img(ref),
        uploaded: !!uploadKeyOf(ref),
      })),
    },
    reviews: w.reviews || [],
    pages: w.pages || [],
    seo: w.seo || {},
    publicUrl: `${config.publicSiteBaseUrl}/c/${clinic.slug}`,
  };
}

/* --------------------------- image uploads (CMS_BASIC) --------------------------- */

const SLOTS = {
  // slot → { width, height, fit } normalisation profile
  gallery: { width: 1600, height: 1600, fit: 'inside' },
  hero: { width: 1600, height: 1600, fit: 'inside' },
  logo: { width: 512, height: 512, fit: 'inside' },
};
const MAX_GALLERY = 24;

/**
 * Upload an image into one of the CMS slots. Bytes are normalised to a compact JPEG and stored
 * PRIVATELY; only the storage key is persisted (hard rule 3). `gallery` appends, `hero`/`logo`
 * replace. Returns the refreshed config so the editor re-renders from server truth.
 */
async function uploadImage(ctx, slot, file) {
  const profile = SLOTS[slot];
  if (!profile) throw new AppError(400, 'Unknown image slot');
  if (!file || !file.buffer?.length) throw new AppError(400, 'No image uploaded');
  if (!/^image\//.test(file.mimetype || '')) throw new AppError(400, 'File must be an image (JPG, PNG, or WebP).');

  const clinic = await loadClinic(ctx);
  let processed;
  try {
    processed = await sharp(file.buffer)
      .rotate()
      .resize({ width: profile.width, height: profile.height, fit: profile.fit, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
  } catch {
    throw new AppError(400, "Couldn't read that image — please try a JPG, PNG, or WebP.");
  }

  // Unique per upload so a replaced image is never served from a cached URL.
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const key = `website/${clinic._id}/${slot}-${stamp}.jpg`;
  await storage.saveFile({ clinicId: ctx.clinicId, key, buffer: processed, contentType: 'image/jpeg' });
  const ref = `${UPLOAD_PREFIX}${key}`;

  if (slot === 'gallery') {
    const gallery = (clinic.website?.content?.gallery || []).slice(0, MAX_GALLERY - 1);
    await repo(ctx).updateById(clinic._id, { 'website.content.gallery': [...gallery, ref] });
  } else if (slot === 'hero') {
    await discardUpload(ctx, clinic.website?.content?.hero?.imageUrl);
    await repo(ctx).updateById(clinic._id, { 'website.content.hero.imageUrl': ref });
  } else {
    await discardUpload(ctx, clinic.website?.theme?.logoUrl);
    await repo(ctx).updateById(clinic._id, { 'website.theme.logoUrl': ref });
  }
  return getSiteConfig(ctx);
}

/** Best-effort delete of the bytes behind a replaced/removed ref. Never fails the request. */
async function discardUpload(ctx, ref) {
  const key = uploadKeyOf(ref);
  if (!key) return;
  try {
    await storage.deleteFile({ clinicId: ctx.clinicId, key });
  } catch {
    /* orphaned bytes are harmless; the reference is already gone */
  }
}

/** Remove one gallery entry by position, deleting its bytes when we hosted them. */
async function removeGalleryImage(ctx, index) {
  const clinic = await loadClinic(ctx);
  const gallery = clinic.website?.content?.gallery || [];
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i >= gallery.length) throw new AppError(404, 'Image not found');
  await discardUpload(ctx, gallery[i]);
  await repo(ctx).updateById(clinic._id, { 'website.content.gallery': gallery.filter((_, n) => n !== i) });
  return getSiteConfig(ctx);
}

/** Reorder the gallery. `order` is the full list of current indexes in their new order. */
async function reorderGallery(ctx, order) {
  const clinic = await loadClinic(ctx);
  const gallery = clinic.website?.content?.gallery || [];
  const idx = clampArr(order, MAX_GALLERY).map(Number);
  const valid = idx.length === gallery.length && new Set(idx).size === gallery.length && idx.every((n) => n >= 0 && n < gallery.length);
  if (!valid) throw new AppError(400, 'Invalid gallery order');
  await repo(ctx).updateById(clinic._id, { 'website.content.gallery': idx.map((n) => gallery[n]) });
  return getSiteConfig(ctx);
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
  uploadImage,
  removeGalleryImage,
  reorderGallery,
  listPages,
  createPage,
  updatePage,
  deletePage,
  getReviews,
  updateReviews,
  updateSeo,
};
