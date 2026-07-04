'use strict';

const { Clinic, Patient, Invoice, Prescription } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const { sendNotification } = require('./notifications');
const { whatsappReady } = require('./commsService');
const emailTemplates = require('../lib/comms/templates');
const publicLinks = require('../lib/publicLinks');
const messageLog = require('./messageLogService');
const AppError = require('../utils/AppError');

/**
 * Staff-initiated patient sends (§5.23): payment links for an invoice's dues and
 * shareable document links (invoice / prescription). Delivery mirrors the CRM rules —
 * email whenever there's an address, WhatsApp additionally when the channel is truly
 * usable; every attempt lands in the communications log. The returned URL lets the
 * front desk copy-paste it into any channel manually too.
 */

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmtINR = (n) => `₹${Number(n || 0).toLocaleString('en-IN')}`;

async function loadClinic(ctx) {
  const clinic = await Clinic.findOne({ clinicId: ctx.clinicId }).lean();
  if (!clinic) throw new AppError(404, 'Clinic not found');
  return clinic;
}

async function loadPatient(ctx, patientId) {
  const patient = await tenantRepo(Patient, ctx, { audit: false }).findById(patientId, { lean: true });
  if (!patient) throw new AppError(404, 'Patient not found');
  return patient;
}

/** Send on email + WhatsApp (when usable). Returns which channels succeeded. */
async function deliver(ctx, clinic, patient, { subject, text, html, template }) {
  const logBase = { patientId: patient._id, patientName: patient.name, template, subject };
  const sent = [];

  if (patient.email) {
    try {
      await sendNotification({ channel: 'email', to: patient.email, subject, message: text, html, attachments: await emailTemplates.emailAttachments(clinic, 'generic') });
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'sent' });
      sent.push('email');
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'email', to: patient.email, status: 'failed', error: err.message }).catch(() => {});
    }
  }
  if (whatsappReady(clinic, patient)) {
    try {
      await sendNotification({ channel: 'whatsapp', to: patient.phone, message: `${subject}\n\n${text}` });
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'sent' });
      sent.push('whatsapp');
    } catch (err) {
      await messageLog.record(ctx, { ...logBase, channel: 'whatsapp', to: patient.phone, status: 'failed', error: err.message }).catch(() => {});
    }
  }
  return sent;
}

/** Send a "pay your dues online" link for an invoice (§5.23, PAYMENT_LINKS). */
async function sendPaymentLink(ctx, invoiceId) {
  const invoice = await tenantRepo(Invoice, ctx, { audit: false }).findById(invoiceId, { lean: true });
  if (!invoice) throw new AppError(404, 'Invoice not found');
  const balance = round2(invoice.total - invoice.amountPaid);
  if (!(balance > 0)) throw new AppError(400, 'This invoice has no outstanding balance');

  const [clinic, patient] = await Promise.all([loadClinic(ctx), loadPatient(ctx, invoice.patientId)]);
  const url = publicLinks.payUrl(ctx.clinicId, invoice._id);

  const subject = `Payment request — ${invoice.invoiceNumber} · ${clinic.name}`;
  const text =
    `Dear ${patient.name || 'there'},\n\n` +
    `This is a payment request from ${clinic.name} for invoice ${invoice.invoiceNumber}.\n\n` +
    `Amount due: ${fmtINR(balance)}${invoice.amountPaid > 0 ? ` (of ${fmtINR(invoice.total)} total — ${fmtINR(invoice.amountPaid)} already received, thank you)` : ''}\n\n` +
    `Pay securely online (UPI, cards, netbanking):\n${url}\n\n` +
    `If you've already settled this at the clinic, please ignore this message.\n\n` +
    `Thank you,\nTeam ${clinic.name}`;
  const html = emailTemplates.wrapHtml(clinic, {
    title: `Payment request · ${fmtINR(balance)}`,
    text,
    ctas: [{ href: url, label: `Pay ${fmtINR(balance)} securely` }],
  });

  const sent = await deliver(ctx, clinic, patient, { subject, text, html, template: 'payment_link' });
  if (!sent.length && !patient.email && !patient.phone) {
    throw new AppError(400, 'The patient has no email or phone on file — add one to send a payment link');
  }
  return { url, sent, balance };
}

/** Share an invoice or prescription as a tokenized view/download link (§5.23). */
async function shareDocument(ctx, { kind, id }) {
  if (!['invoice', 'prescription'].includes(kind)) throw new AppError(400, 'kind must be invoice or prescription');

  let doc;
  let label;
  if (kind === 'invoice') {
    doc = await tenantRepo(Invoice, ctx, { audit: false }).findById(id, { lean: true });
    label = doc ? `Invoice ${doc.invoiceNumber}` : '';
  } else {
    doc = await tenantRepo(Prescription, ctx, { audit: false }).findById(id, { lean: true });
    label = 'Your prescription';
  }
  if (!doc) throw new AppError(404, 'Document not found');

  const [clinic, patient] = await Promise.all([loadClinic(ctx), loadPatient(ctx, doc.patientId)]);
  const url = publicLinks.docUrl(ctx.clinicId, kind, doc._id);

  const subject = `${label} from ${clinic.name}`;
  const text =
    `Dear ${patient.name || 'there'},\n\n` +
    `${label} from your visit to ${clinic.name} is ready. You can view, download, or print it here:\n${url}\n\n` +
    `Keep this link safe — anyone with it can open the document.\n\n` +
    `Regards,\nTeam ${clinic.name}`;
  const html = emailTemplates.wrapHtml(clinic, {
    title: label,
    text,
    ctas: [{ href: url, label: 'View document' }],
  });

  const sent = await deliver(ctx, clinic, patient, { subject, text, html, template: 'document' });
  if (!sent.length && !patient.email && !patient.phone) {
    throw new AppError(400, 'The patient has no email or phone on file — add one to share the document');
  }
  return { url, sent };
}

module.exports = { sendPaymentLink, shareDocument };
