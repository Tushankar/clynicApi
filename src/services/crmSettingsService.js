'use strict';

const sharp = require('sharp');
const { Clinic } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const templates = require('../lib/comms/templates');
const storage = require('../lib/storage');
const { adapters } = require('./notifications');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * CRM automation settings (§5.13) — the owner's control panel behind the CRM page:
 * automation toggles + send hour, AI personalization (Premium), the editable email COLOR
 * theme, and the campaign templates (defaults for everyone; OVERRIDES incl. uploaded hero
 * images are Premium/TEMPLATE_EDITING). All writes go through the tenant repo (audited).
 */

const KINDS = ['birthday', 'followup', 'reengage'];
const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;
const THEME_KEYS = ['accent', 'bg', 'heading', 'text'];

function channelStatus(clinic) {
  const wa = typeof adapters.whatsapp.getStatus === 'function' ? adapters.whatsapp.getStatus() : { enabled: false, status: 'disabled' };
  return {
    email: { configured: Boolean(config.mail.host), from: config.mail.from },
    whatsapp: {
      driverEnabled: Boolean(config.whatsapp.enabled),
      planAllowed: planHasFeature(clinic.subscriptionPlan, 'WHATSAPP_REMINDERS'),
      status: wa.status,
      connectedAs: wa.me || null,
      lastError: wa.lastError || null,
    },
  };
}

/** A browser-usable image src for a template card: external URL, or a data URI for an upload. */
async function imagePreviewFor(clinic, kind) {
  const t = templates.templateFor(clinic, kind);
  if (t.imageKey) {
    try {
      const buf = await storage.readBuffer({ clinicId: clinic.clinicId, key: t.imageKey });
      if (buf?.length) return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch {
      /* fall through */
    }
  }
  return t.imageUrl || '';
}

async function view(clinic) {
  const s = clinic.crmSettings || {};
  const theme = s.emailTheme || {};
  const tmpl = await Promise.all(
    KINDS.map(async (kind) => {
      const t = templates.templateFor(clinic, kind);
      return {
        kind,
        label: t.label,
        subject: t.subject,
        body: t.body,
        imageUrl: t.imageUrl, // external override (empty if uploaded/default)
        hasUpload: Boolean(t.imageKey),
        imageSrc: await imagePreviewFor(clinic, kind), // for the UI thumbnail/preview
        customized: t.customized,
      };
    })
  );
  return {
    settings: {
      birthdayEnabled: Boolean(s.birthdayEnabled),
      followupEnabled: Boolean(s.followupEnabled),
      sendHour: s.sendHour ?? 9,
      aiPersonalize: Boolean(s.aiPersonalize),
    },
    // Resolved theme (what emails actually use) + the raw overrides (what's been set).
    emailTheme: templates.resolveTheme(clinic),
    emailThemeOverrides: { accent: theme.accent || '', bg: theme.bg || '', heading: theme.heading || '', text: theme.text || '' },
    templates: tmpl,
    channels: channelStatus(clinic),
    entitlements: {
      automation: planHasFeature(clinic.subscriptionPlan, 'CRM_AUTOMATION'),
      templateEditing: planHasFeature(clinic.subscriptionPlan, 'TEMPLATE_EDITING'),
      ai: planHasFeature(clinic.subscriptionPlan, 'AI_FEATURES'),
    },
  };
}

async function getSettings(ctx) {
  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  return view(clinic);
}

const asObject = (doc) => (doc?.toObject ? doc.toObject() : doc);

/** Owner: toggle automations / send hour / AI personalization (AI needs AI_FEATURES). */
async function updateSettings(ctx, body = {}) {
  const repo = tenantRepo(Clinic, ctx); // audited (rule 7)
  const clinic = await repo.findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');

  const patch = {};
  if (typeof body.birthdayEnabled === 'boolean') patch['crmSettings.birthdayEnabled'] = body.birthdayEnabled;
  if (typeof body.followupEnabled === 'boolean') patch['crmSettings.followupEnabled'] = body.followupEnabled;
  if (body.sendHour !== undefined) {
    const h = Number(body.sendHour);
    if (!Number.isInteger(h) || h < 0 || h > 23) throw new AppError(400, 'sendHour must be 0–23');
    patch['crmSettings.sendHour'] = h;
  }
  if (typeof body.aiPersonalize === 'boolean') {
    if (body.aiPersonalize && !planHasFeature(clinic.subscriptionPlan, 'AI_FEATURES')) {
      throw new AppError(403, 'AI personalization is a Premium feature.');
    }
    patch['crmSettings.aiPersonalize'] = body.aiPersonalize;
  }
  if (!Object.keys(patch).length) throw new AppError(400, 'Nothing to update');

  const updated = await repo.updateById(clinic._id, patch);
  return view(asObject(updated));
}

/** Owner + Premium (TEMPLATE_EDITING): edit the email color theme. Empty '' resets a color. */
async function updateTheme(ctx, colors = {}) {
  const repo = tenantRepo(Clinic, ctx);
  const clinic = await repo.findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');

  const patch = {};
  for (const key of THEME_KEYS) {
    if (typeof colors[key] === 'string') {
      const v = colors[key].trim();
      if (v && !HEX.test(v)) throw new AppError(400, `${key} must be a hex color like #2563eb (or empty to reset).`);
      patch[`crmSettings.emailTheme.${key}`] = v;
    }
  }
  if (!Object.keys(patch).length) throw new AppError(400, 'Nothing to update');
  const updated = await repo.updateById(clinic._id, patch);
  return view(asObject(updated));
}

/** Owner + Premium: override a template's subject/body/external-image. */
async function updateTemplate(ctx, kind, { subject, body, imageUrl } = {}) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'Unknown template');
  const repo = tenantRepo(Clinic, ctx); // audited
  const clinic = await repo.findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');

  const patch = {};
  if (typeof subject === 'string') patch[`crmSettings.templates.${kind}.subject`] = subject.trim().slice(0, 200);
  if (typeof body === 'string') patch[`crmSettings.templates.${kind}.body`] = body.trim().slice(0, 4000);
  if (typeof imageUrl === 'string') {
    const img = imageUrl.trim().slice(0, 500);
    if (img && img !== 'none' && !/^https?:\/\//i.test(img)) {
      throw new AppError(400, 'Image must be a hosted http(s) URL (e.g. an Unsplash link), or "none" to remove it.');
    }
    patch[`crmSettings.templates.${kind}.imageUrl`] = img;
    patch[`crmSettings.templates.${kind}.imageKey`] = ''; // a pasted URL supersedes any upload
  }
  if (!Object.keys(patch).length) throw new AppError(400, 'Nothing to update');

  const updated = await repo.updateById(clinic._id, patch);
  return view(asObject(updated));
}

/**
 * Owner + Premium: upload a hero image for a template. The image is normalized (resized to a
 * 1240px-wide JPEG) and stored privately; at send time it's inlined via CID so it renders in
 * any inbox. Storing the KEY (not a public URL) keeps it consistent with hard rule 3.
 */
async function uploadTemplateImage(ctx, kind, file) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'Unknown template');
  if (!file || !file.buffer?.length) throw new AppError(400, 'No image uploaded');
  if (!/^image\//.test(file.mimetype || '')) throw new AppError(400, 'File must be an image (JPG, PNG, or WebP).');

  const repo = tenantRepo(Clinic, ctx);
  const clinic = await repo.findOne({});
  if (!clinic) throw new AppError(404, 'Clinic not found');

  // Normalize: cap width, strip metadata, re-encode as a reasonably compressed JPEG.
  let processed;
  try {
    processed = await sharp(file.buffer).rotate().resize({ width: 1240, height: 620, fit: 'cover', withoutEnlargement: false }).jpeg({ quality: 80 }).toBuffer();
  } catch {
    throw new AppError(400, "Couldn't read that image — please try a JPG, PNG, or WebP.");
  }

  const key = `email-assets/${kind}.jpg`;
  await storage.saveFile({ clinicId: ctx.clinicId, key, buffer: processed, contentType: 'image/jpeg' });
  const updated = await repo.updateById(clinic._id, {
    [`crmSettings.templates.${kind}.imageKey`]: key,
    [`crmSettings.templates.${kind}.imageUrl`]: '', // uploaded image wins over any external URL
  });
  return view(asObject(updated));
}

module.exports = { getSettings, updateSettings, updateTheme, updateTemplate, uploadTemplateImage, KINDS };
