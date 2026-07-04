'use strict';

const crypto = require('crypto');
const { OtpChallenge } = require('../models');
const { sendNotification } = require('./notifications');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * OTP for public booking + patient portal (section 3 / 10.5). Identity is EITHER an email OR a
 * phone number, so patients without an email can still verify (via WhatsApp when the clinic has it
 * connected, else SMS when configured). Codes are stored hashed; a challenge is clinic-scoped,
 * short-lived, and consumed on success. The email path is byte-for-byte unchanged.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Classify a contact string into { kind:'email'|'phone', identifier } (phone → last-10-digits). */
function classify(contact) {
  const raw = String(contact || '').trim();
  if (EMAIL_RE.test(raw.toLowerCase())) return { kind: 'email', identifier: raw.toLowerCase() };
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 10) return { kind: 'phone', identifier: digits.slice(-10) };
  return null;
}

function idFilter(c) {
  return c.kind === 'email' ? { email: c.identifier } : { phone: c.identifier };
}

// HMAC keyed by a server-side secret (config.otp.hashSecret) — a leaked
// otpChallenges row cannot be brute-forced offline without the secret.
function hashCode(clinicId, identifier, code) {
  return crypto.createHmac('sha256', config.otp.hashSecret).update(`${clinicId}:${identifier}:${code}`).digest('hex');
}

function windowStart() {
  return new Date(Date.now() - config.otp.throttleWindowMinutes * 60000);
}

function genCode(len) {
  let c = '';
  for (let i = 0; i < len; i += 1) c += crypto.randomInt(0, 10);
  return c;
}

/** Pick the delivery channel for a phone: WhatsApp when connected, else SMS (may be unconfigured). */
function phoneChannel() {
  const { adapters } = require('./notifications');
  const waOk = config.whatsapp.enabled && typeof adapters.whatsapp.isConnected === 'function' && adapters.whatsapp.isConnected();
  return waOk ? 'whatsapp' : 'sms';
}

async function requestOtp(clinicId, contactRaw) {
  const c = classify(contactRaw);
  if (!c) throw new AppError(400, 'A valid email or 10-digit mobile number is required');

  // Throttle code requests per identity+clinic so the per-challenge attempt cap can't
  // be reset by simply minting new challenges (brute-force defense, hard-rule-4 integrity).
  const recent = await OtpChallenge.find({ clinicId, ...idFilter(c), createdAt: { $gte: windowStart() } }).sort({ createdAt: -1 });
  if (recent.length >= config.otp.maxRequestsPerWindow) {
    throw new AppError(429, 'Too many code requests. Please try again later.');
  }
  if (recent[0] && Date.now() - new Date(recent[0].createdAt).getTime() < config.otp.minRequestIntervalSeconds * 1000) {
    throw new AppError(429, 'Please wait a moment before requesting another code.');
  }

  const code = genCode(config.otp.length);
  const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60000);
  const channel = c.kind === 'email' ? 'email' : phoneChannel();
  await OtpChallenge.create({ clinicId, ...idFilter(c), channel, codeHash: hashCode(clinicId, c.identifier, code), expiresAt });

  try {
    await sendNotification({
      channel,
      to: c.identifier,
      subject: 'Your verification code',
      message: `Your verification code is ${code}. It expires in ${config.otp.ttlMinutes} minutes.`,
    });
  } catch (err) {
    // Email failures still surface (as before). For phone, if the channel isn't available
    // (e.g. WhatsApp not paired and SMS not configured), fail with a friendly message in prod;
    // in dev the returned devCode keeps the flow testable.
    if (config.isProd) {
      if (c.kind === 'email') throw err;
      throw new AppError(503, 'We couldn’t send a code to that number. Please try your email instead.');
    }
  }

  const res = { ok: true, expiresInMinutes: config.otp.ttlMinutes, channel };
  // Dev convenience only (no real SMTP, non-prod): expose the code so the flow is testable.
  if (!config.isProd && !config.mail.host) res.devCode = code;
  return res;
}

async function verifyOtp(clinicId, contactRaw, code) {
  const c = classify(contactRaw);
  if (!c) throw new AppError(400, 'A valid email or mobile number is required');

  // Failure budget across ALL recent challenges for this identity+clinic — re-requesting
  // a fresh code does not reset it, so the 1,000,000-code space can't be brute-forced.
  const recent = await OtpChallenge.find({ clinicId, ...idFilter(c), createdAt: { $gte: windowStart() } });
  const totalFailures = recent.reduce((sum, ch) => sum + (ch.attempts || 0), 0);
  if (totalFailures >= config.otp.maxFailuresPerWindow) {
    throw new AppError(429, 'Too many attempts. Please request a new code and try again later.');
  }

  const challenge = await OtpChallenge.findOne({
    clinicId,
    ...idFilter(c),
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!challenge) throw new AppError(400, 'No active code. Request a new one.');
  if (challenge.attempts >= config.otp.maxAttempts) throw new AppError(429, 'Too many attempts. Request a new code.');

  if (challenge.codeHash !== hashCode(clinicId, c.identifier, code)) {
    challenge.attempts += 1;
    await challenge.save();
    throw new AppError(400, 'Incorrect code');
  }
  challenge.verifiedAt = new Date();
  await challenge.save();
  return { ok: true };
}

/** Atomically consume a verified, unexpired, unconsumed challenge (called at booking/login). */
async function consumeVerified(clinicId, contactRaw) {
  const c = classify(contactRaw);
  if (!c) return false;
  const res = await OtpChallenge.findOneAndUpdate(
    { clinicId, ...idFilter(c), verifiedAt: { $ne: null }, consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { sort: { createdAt: -1 }, new: true }
  );
  return !!res;
}

module.exports = { requestOtp, verifyOtp, consumeVerified, classify };
