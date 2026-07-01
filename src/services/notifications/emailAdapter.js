'use strict';

const nodemailer = require('nodemailer');
const config = require('../../config/env');

/**
 * emailAdapter (Nodemailer) — the primary, free reminder + OTP channel for Phase 1.
 *
 * With SMTP creds it sends for real; without them it uses a JSON transport that
 * captures the message instead of sending (so reminders + OTP are verifiable in dev
 * with no SMTP account). Every send is recorded in `sentLog` for dev/test inspection.
 */
let transporter = null;
const sentLog = [];

function getTransporter() {
  if (transporter) return transporter;
  if (config.mail.host) {
    transporter = nodemailer.createTransport({
      host: config.mail.host,
      port: config.mail.port,
      secure: config.mail.secure,
      auth: config.mail.user ? { user: config.mail.user, pass: config.mail.pass } : undefined,
    });
  } else {
    transporter = nodemailer.createTransport({ jsonTransport: true });
  }
  return transporter;
}

async function send({ to, subject, message, html }) {
  if (!to) throw new Error('emailAdapter: missing recipient');
  const info = await getTransporter().sendMail({
    from: config.mail.from,
    to,
    subject: subject || 'Notification',
    text: message,
    html,
  });
  const record = { to, subject, messageId: info.messageId, dev: !config.mail.host, at: new Date().toISOString() };
  sentLog.push(record);
  if (!config.mail.host && !config.isProd) {
    // eslint-disable-next-line no-console
    console.log(`[email:dev] → ${to} · "${subject}"`);
  }
  return { channel: 'email', ok: true, ...record };
}

// Dev/test inspection helpers.
function getSentLog() {
  return sentLog.slice();
}
function clearSentLog() {
  sentLog.length = 0;
}

module.exports = { send, getSentLog, clearSentLog };
