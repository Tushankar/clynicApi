'use strict';

const { MessageLog } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');

/**
 * Outbound communications log (§5.13/5.17). Records every email/WhatsApp the clinic sends
 * so the owner can see "what did we send, to whom, how many times, which template". Recording
 * is best-effort — it must NEVER throw into the send path (a logging failure can't lose a send).
 */
const TEMPLATE_LABEL = {
  reengage: 'Re-engagement',
  birthday: 'Birthday wish',
  followup: 'Follow-up reminder',
  appointment_24h: 'Reminder · 24h',
  appointment_2h: 'Reminder · 2h',
  booking_confirmation: 'Booking confirmation',
  appointment_cancelled: 'Cancellation notice',
  appointment_rescheduled: 'Reschedule notice',
  review_request: 'Review request',
  recall: 'Treatment recall',
  waitlist: 'Waitlist alert',
  payment_link: 'Payment link',
  document: 'Shared document',
  custom: 'Message',
};

// Valid templates, read from the schema so the coercion backstop can't drift.
const KNOWN_TEMPLATES = new Set(MessageLog.schema.path('template').enumValues);

function repo(ctx) {
  return tenantRepo(MessageLog, ctx, { audit: false });
}

/**
 * Record one outbound message. Best-effort: it must NEVER throw into the send path. An unknown
 * template is coerced to 'custom' (and logged) so the row is still persisted — a validation
 * throw here used to drop the row entirely, so a failed booking/review/recall left no trace.
 */
async function record(ctx, { patientId, patientName, channel = 'email', template = 'custom', subject, to, status = 'sent', error = null } = {}) {
  let safeTemplate = template;
  if (!KNOWN_TEMPLATES.has(template)) {
    console.warn(`[messageLogService] unknown template "${template}" — coerced to "custom". Add it to the MessageLog.template enum.`);
    safeTemplate = 'custom';
  }
  try {
    return await repo(ctx).create({
      patientId: patientId || null,
      patientName,
      channel,
      template: safeTemplate,
      subject,
      to,
      status,
      error: error ? String(error).slice(0, 500) : null,
      sentBy: ctx.actorId || 'system',
      sentByRole: ctx.actorRole || 'system',
    });
  } catch (err) {
    // Never break a send because logging failed — but do NOT do it silently.
    console.error('[messageLogService] failed to record outbound message:', err?.message || err);
    return null;
  }
}

function view(m) {
  return {
    _id: String(m._id),
    patientId: m.patientId ? String(m.patientId) : null,
    patientName: m.patientName || '',
    channel: m.channel,
    template: m.template,
    templateLabel: TEMPLATE_LABEL[m.template] || m.template,
    subject: m.subject || '',
    to: m.to || '',
    status: m.status,
    error: m.error || null,
    sentBy: m.sentBy || null,
    sentByRole: m.sentByRole || null,
    createdAt: m.createdAt,
  };
}

/** List sent messages (optionally for one patient / template), newest first — tenant-scoped. */
async function list(ctx, { patientId, template, limit = 100 } = {}) {
  const filter = {};
  if (patientId) filter.patientId = patientId;
  if (template) filter.template = template;
  const items = await repo(ctx).find(filter, { sort: { createdAt: -1 }, limit, lean: true });
  return items.map(view);
}

/** Totals + a per-template breakdown (count, failures, last-sent) for the summary cards. */
async function summary(ctx) {
  const rows = await MessageLog.aggregate([
    { $match: { clinicId: ctx.clinicId, deletedAt: null } },
    {
      $group: {
        _id: '$template',
        count: { $sum: 1 },
        failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
        lastSentAt: { $max: '$createdAt' },
      },
    },
    { $sort: { count: -1 } },
  ]);
  const byTemplate = rows.map((r) => ({
    template: r._id,
    label: TEMPLATE_LABEL[r._id] || r._id,
    count: r.count,
    failed: r.failed,
    lastSentAt: r.lastSentAt,
  }));
  return {
    total: byTemplate.reduce((s, r) => s + r.count, 0),
    failed: byTemplate.reduce((s, r) => s + r.failed, 0),
    byTemplate,
  };
}

module.exports = { record, list, summary, TEMPLATE_LABEL };
