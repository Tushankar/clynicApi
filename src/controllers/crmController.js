'use strict';

const asyncHandler = require('../utils/asyncHandler');
const crmService = require('../services/crmService');
const crmSettingsService = require('../services/crmSettingsService');
const campaignService = require('../services/campaignService');
const commsService = require('../services/commsService');
const { Clinic } = require('../models');
const AppError = require('../utils/AppError');

const summary = asyncHandler(async (req, res) => {
  res.json(await crmService.summary(req.ctx));
});

const segment = asyncHandler(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  res.json({ items: await crmService.segment(req.ctx, req.params.key, { limit }) });
});

const reengage = asyncHandler(async (req, res) => {
  // Pass the clinic display name for the message body (ctx carries only ids/role).
  res.json(await crmService.reengage({ ...req.ctx, clinicName: req.clinic?.name }, req.params.id));
});

// ---- Automation settings + templates (§5.13) ----------------------------------------
const getSettings = asyncHandler(async (req, res) => {
  res.json(await crmSettingsService.getSettings(req.ctx));
});

const updateSettings = asyncHandler(async (req, res) => {
  res.json(await crmSettingsService.updateSettings(req.ctx, req.body));
});

const updateTemplate = asyncHandler(async (req, res) => {
  res.json(await crmSettingsService.updateTemplate(req.ctx, req.params.kind, req.body));
});

const updateTheme = asyncHandler(async (req, res) => {
  res.json(await crmSettingsService.updateTheme(req.ctx, req.body));
});

const uploadImage = asyncHandler(async (req, res) => {
  res.json(await crmSettingsService.uploadTemplateImage(req.ctx, req.params.kind, req.file));
});

/** Turn CID attachments into data URIs so the in-app preview matches the delivered email. */
async function inlineCids(html, attachments) {
  const fs = require('fs').promises;
  let out = html;
  for (const att of attachments) {
    if (!out.includes(`cid:${att.cid}`)) continue;
    const buf = att.content || (att.path ? await fs.readFile(att.path) : null);
    if (!buf) continue;
    const mime = att.filename && att.filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png';
    out = out.split(`cid:${att.cid}`).join(`data:${mime};base64,${buf.toString('base64')}`);
  }
  return out;
}

/** Owner: the rendered HTML for a template (sample data) — powers the in-app live preview. */
const previewTemplate = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findOne({ clinicId: req.ctx.clinicId }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const templates = require('../lib/comms/templates');
  const { subject, html, text } = templates.render(clinic, req.params.kind, { name: 'Priya Sharma' });
  const attachments = await templates.emailAttachments(clinic, req.params.kind);
  res.json({ subject, html: await inlineCids(html, attachments), text });
});

/** Owner: send a rendered template preview to an address they specify (real delivery). */
const testTemplate = asyncHandler(async (req, res) => {
  const { kind } = req.params;
  const email = String(req.body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'A valid email is required');
  const clinic = await Clinic.findOne({ clinicId: req.ctx.clinicId }).lean();
  const sample = { _id: null, name: req.body.sampleName || 'Priya Sharma', email };
  const rendered = await commsService.renderForPatient(clinic, sample, kind);
  const { sendNotification } = require('../services/notifications');
  const templates = require('../lib/comms/templates');
  await sendNotification({ channel: 'email', to: email, subject: `[Test] ${rendered.subject}`, message: rendered.text, html: rendered.html, attachments: await templates.emailAttachments(clinic, kind) });
  res.json({ ok: true, to: email, subject: rendered.subject, personalized: rendered.personalized });
});

/** Owner: run a campaign for THIS clinic right now (also used to verify the setup). */
const runCampaign = asyncHandler(async (req, res) => {
  const clinic = await Clinic.findOne({ clinicId: req.ctx.clinicId }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const which = req.body.campaign;
  if (which === 'birthday') return res.json({ campaign: 'birthday', ...(await campaignService.runBirthdayCampaign(clinic)) });
  if (which === 'followup') return res.json({ campaign: 'followup', ...(await campaignService.runFollowupCampaign(clinic)) });
  throw new AppError(400, "campaign must be 'birthday' or 'followup'");
});

module.exports = { summary, segment, reengage, getSettings, updateSettings, updateTheme, updateTemplate, uploadImage, previewTemplate, testTemplate, runCampaign };
