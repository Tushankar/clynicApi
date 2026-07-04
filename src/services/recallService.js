'use strict';

const { Recall, Patient, Doctor, Clinic } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { planHasFeature } = require('../config/plans');
const { sendNotification } = require('./notifications');
const { whatsappReady } = require('./commsService');
const emailTemplates = require('../lib/comms/templates');
const publicLinks = require('../lib/publicLinks');
const messageLog = require('./messageLogService');
const { dayRange } = require('../lib/datetime');
const AppError = require('../utils/AppError');

/**
 * Treatment recalls (§5.22, Premium) — "cleaning due in 6 months", "annual check-up".
 * Staff schedule a recall against a patient; the campaign tick delivers it (with a
 * booking link) when it falls due and flips status to 'sent'. A new booking for the
 * patient auto-closes open recalls as 'booked' (appointmentService).
 */

function repo(ctx, { audit = true } = {}) {
  return tenantRepo(Recall, ctx, { audit });
}

function list(ctx, { status, patientId, from, to } = {}) {
  const filter = {};
  if (status) filter.status = status;
  if (patientId) filter.patientId = patientId;
  if (from || to) {
    filter.dueDate = {};
    if (from) filter.dueDate.$gte = new Date(from);
    if (to) filter.dueDate.$lte = new Date(to);
  }
  return repo(ctx, { audit: false }).find(filter, { sort: { dueDate: 1 }, limit: 500, lean: true });
}

async function create(ctx, { patientId, doctorId, label, dueDate, notes } = {}) {
  if (!patientId) throw new AppError(400, 'patientId is required');
  if (!label || !String(label).trim()) throw new AppError(400, 'A recall label is required (e.g. "6-month cleaning")');
  const due = new Date(dueDate);
  if (Number.isNaN(due.getTime())) throw new AppError(400, 'A valid due date is required');
  if (due < dayRange(new Date()).start) throw new AppError(400, 'The due date must be today or later');

  const patient = await tenantRepo(Patient, ctx).findById(patientId);
  if (!patient) throw new AppError(404, 'Patient not found');

  let doctorName = '';
  let docId = null;
  if (doctorId) {
    const doctor = await tenantRepo(Doctor, ctx).findById(doctorId);
    if (doctor) {
      doctorName = doctor.name;
      docId = doctor._id;
    }
  }

  return repo(ctx).create({
    patientId: patient._id,
    patientName: patient.name,
    doctorId: docId,
    doctorName,
    label: String(label).trim().slice(0, 120),
    dueDate: due,
    status: 'scheduled',
    notes: String(notes || '').trim().slice(0, 500),
    createdBy: ctx.actorId || null,
  });
}

async function cancel(ctx, id) {
  const recall = await repo(ctx, { audit: false }).findById(id);
  if (!recall) throw new AppError(404, 'Recall not found');
  if (['booked', 'cancelled'].includes(recall.status)) return recall;
  return repo(ctx).updateById(id, { status: 'cancelled' });
}

/** Deliver one due recall on every available channel. Returns true when anything sent. */
async function deliverRecall(clinic, recall) {
  const sysCtx = { clinicId: clinic.clinicId, actorId: 'system', actorRole: 'system' };
  const patient = await Patient.findOne({ clinicId: clinic.clinicId, _id: recall.patientId, deletedAt: null }).lean();
  if (!patient || (!patient.email && !patient.phone)) return false;

  const bookUrl = publicLinks.bookingUrl(clinic.slug);
  const subject = `It's time for your ${recall.label} — ${clinic.name}`;
  const text =
    `Dear ${patient.name || 'there'},\n\n` +
    `Our records show your ${recall.label}${recall.doctorName ? ` with ${recall.doctorName}` : ''} is due. ` +
    `Staying on schedule keeps small things small — it only takes a minute to book.\n\n` +
    `Book online here:\n${bookUrl}\n\n` +
    `Or call us and the front desk will find you a convenient slot.\n\n` +
    `Warm regards,\nTeam ${clinic.name}`;
  const logBase = { patientId: patient._id, patientName: patient.name, template: 'recall', subject };

  let delivered = false;
  if (patient.email) {
    try {
      const html = emailTemplates.wrapHtml(clinic, { title: `Time for your ${recall.label}`, text });
      await sendNotification({ channel: 'email', to: patient.email, subject, message: text, html, attachments: await emailTemplates.emailAttachments(clinic, 'followup') });
      await messageLog.record(sysCtx, { ...logBase, channel: 'email', to: patient.email, status: 'sent' });
      delivered = true;
    } catch (err) {
      await messageLog.record(sysCtx, { ...logBase, channel: 'email', to: patient.email, status: 'failed', error: err.message }).catch(() => {});
    }
  }
  if (whatsappReady(clinic, patient)) {
    try {
      await sendNotification({ channel: 'whatsapp', to: patient.phone, message: `${subject}\n\n${text}` });
      await messageLog.record(sysCtx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'sent' });
      delivered = true;
    } catch (err) {
      await messageLog.record(sysCtx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'failed', error: err.message }).catch(() => {});
    }
  }
  return delivered;
}

/**
 * Scheduler tick (rides the campaign runner): send every due, still-scheduled recall
 * for entitled clinics. The atomic scheduled→sent claim makes re-runs safe.
 */
async function processDueRecalls(now = new Date()) {
  const due = await Recall.find({ status: 'scheduled', dueDate: { $lte: now }, deletedAt: null })
    .sort({ dueDate: 1 })
    .limit(500)
    .lean();
  if (!due.length) return { processed: 0, sent: 0 };

  const clinicIds = [...new Set(due.map((r) => r.clinicId))];
  const clinics = await Clinic.find({ clinicId: { $in: clinicIds } }).lean();
  const byId = new Map(clinics.map((c) => [c.clinicId, c]));

  let sent = 0;
  for (const recall of due) {
    const clinic = byId.get(recall.clinicId);
    if (!clinic || !planHasFeature(clinic.subscriptionPlan, 'RECALLS')) continue;

    // Atomic claim to an intermediate 'sending' status — concurrent ticks skip a claimed recall
    // (no double-send) WITHOUT prematurely marking it 'sent' before delivery actually succeeds.
    const claimed = await Recall.findOneAndUpdate(
      { _id: recall._id, status: 'scheduled' },
      { $set: { status: 'sending' } },
      { new: true }
    );
    if (!claimed) continue;

    const ok = await deliverRecall(clinic, claimed).catch(() => false);
    if (ok) {
      await Recall.updateOne({ _id: claimed._id }, { $set: { status: 'sent', sentAt: now } });
      sent += 1;
    } else {
      // Undeliverable (no contact / both channels failed) → mark 'failed' (not a false green 'sent')
      // so staff can see it and follow up by phone, and notify them it needs attention.
      await Recall.updateOne({ _id: claimed._id }, { $set: { status: 'failed' } });
      require('./notificationService')
        .emit({ clinicId: claimed.clinicId, actorId: 'system', actorRole: null }, { type: 'other', message: `A treatment recall to ${claimed.patientName || 'a patient'} couldn't be delivered — please follow up.`, link: '/dashboard/crm' })
        .catch(() => {});
    }
  }
  return { processed: due.length, sent };
}

module.exports = { list, create, cancel, processDueRecalls };
