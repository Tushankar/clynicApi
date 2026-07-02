'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');
const { PLANS } = require('../config/plans');

/**
 * clinics — the tenant root. clinicId === Clerk Organization ID.
 * For this collection clinicId equals the org id of the clinic the doc describes,
 * which keeps it uniform with every other tenant collection.
 */

// ---- Public website (§5.19 / 8.6) ---------------------------------------------------
// Platform-hosted only; NO custom/external domain fields. The site's slug is the clinic's
// existing top-level `slug` (already globally unique + indexed) — not duplicated here.
const TEMPLATES = ['clean-clinical', 'warm-family', 'modern-specialist'];

const themeSchema = new mongoose.Schema(
  { primaryColor: { type: String, trim: true, default: '' }, accentColor: { type: String, trim: true, default: '' }, logoUrl: { type: String, trim: true, default: '' } },
  { _id: false }
);
const serviceSchema = new mongoose.Schema(
  { name: { type: String, trim: true }, description: { type: String, trim: true }, icon: { type: String, trim: true } },
  { _id: false }
);
const contentSchema = new mongoose.Schema(
  {
    hero: { headline: { type: String, trim: true }, tagline: { type: String, trim: true }, imageUrl: { type: String, trim: true } },
    about: { type: String, trim: true },
    services: { type: [serviceSchema], default: [] },
    gallery: { type: [String], default: [] },
    contact: { phone: { type: String, trim: true }, email: { type: String, trim: true }, whatsapp: { type: String, trim: true }, address: { type: String, trim: true } },
    mapEmbed: { type: String, trim: true },
  },
  { _id: false }
);
const reviewSchema = new mongoose.Schema(
  { name: { type: String, trim: true }, text: { type: String, trim: true }, rating: { type: Number, min: 1, max: 5, default: 5 }, approved: { type: Boolean, default: false } },
  { _id: false }
);
const pageSchema = new mongoose.Schema(
  { slug: { type: String, trim: true, lowercase: true }, title: { type: String, trim: true }, body: { type: String }, published: { type: Boolean, default: false } },
  { _id: false }
);
const seoSchema = new mongoose.Schema(
  { title: { type: String, trim: true }, description: { type: String, trim: true }, keywords: { type: String, trim: true } },
  { _id: false }
);
const websiteSchema = new mongoose.Schema(
  {
    published: { type: Boolean, default: true }, // §5.19: every clinic gets a LIVE site (owner can unpublish)
    template: { type: String, enum: TEMPLATES, default: 'clean-clinical' },
    theme: { type: themeSchema, default: () => ({}) },
    content: { type: contentSchema, default: () => ({}) },
    reviews: { type: [reviewSchema], default: [] }, // Premium (CMS_ADVANCED)
    pages: { type: [pageSchema], default: [] }, // Premium (CMS_ADVANCED)
    seo: { type: seoSchema, default: () => ({}) }, // Premium (CMS_ADVANCED)
  },
  { _id: false }
);

// ---- CRM automations (§5.13) ---------------------------------------------------------
// Owner-controlled campaign settings. Templates hold OVERRIDES only (Premium/TEMPLATE_EDITING);
// empty string → the professional default in lib/comms/templates.js is used. AI personalization
// is Premium-only (AI_FEATURES) and is a marketing rewrite — never medical content (rule 2).
const campaignTemplateSchema = new mongoose.Schema(
  {
    subject: { type: String, trim: true, default: '' },
    body: { type: String, trim: true, default: '' },
    imageUrl: { type: String, trim: true, default: '' }, // '' = default image · 'none' = no image · http(s) = custom
    imageKey: { type: String, trim: true, default: '' }, // uploaded image (private storage key) — inlined via CID
  },
  { _id: false }
);
// Editable email color theme (empty fields fall back to the professional defaults in code).
const emailThemeSchema = new mongoose.Schema(
  {
    accent: { type: String, trim: true, default: '' }, // hero gradient + buttons
    bg: { type: String, trim: true, default: '' }, // email canvas
    heading: { type: String, trim: true, default: '' }, // headings
    text: { type: String, trim: true, default: '' }, // body copy
  },
  { _id: false }
);
const crmSettingsSchema = new mongoose.Schema(
  {
    birthdayEnabled: { type: Boolean, default: false },
    followupEnabled: { type: Boolean, default: false },
    sendHour: { type: Number, min: 0, max: 23, default: 9 }, // local hour campaigns go out
    aiPersonalize: { type: Boolean, default: false }, // Premium (AI_FEATURES) only
    emailTheme: { type: emailThemeSchema, default: () => ({}) },
    templates: {
      birthday: { type: campaignTemplateSchema, default: () => ({}) },
      followup: { type: campaignTemplateSchema, default: () => ({}) },
      reengage: { type: campaignTemplateSchema, default: () => ({}) },
    },
  },
  { _id: false }
);

const clinicSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, trim: true, lowercase: true }, // public URL /c/:slug AND the website slug
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    gstNumber: { type: String, trim: true },
    logoUrl: { type: String, trim: true },
    publicPageContent: { type: mongoose.Schema.Types.Mixed }, // legacy free-form (pre-§8.6); superseded by `website`
    website: { type: websiteSchema, default: () => ({}) }, // §8.6 public website + CMS content
    crmSettings: { type: crmSettingsSchema, default: () => ({}) }, // CRM campaign automations
    subscriptionPlan: { type: String, enum: PLANS, default: 'basic', required: true },
  },
  { timestamps: true }
);

// One clinic doc per org (unique clinicId).
clinicScoped(clinicSchema, { unique: true });

// Public lookups by slug (section 6). Slug is globally unique for subdomain/path routing.
clinicSchema.index({ slug: 1 }, { unique: true, sparse: true });
clinicSchema.index({ clinicId: 1, slug: 1 });

clinicSchema.statics.TEMPLATES = TEMPLATES;

module.exports = mongoose.model('Clinic', clinicSchema);
