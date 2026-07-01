'use strict';

const crypto = require('crypto');
const { OtpChallenge } = require('../models');
const { sendNotification } = require('./notifications');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Email-OTP for public booking (section 3 / 10.5). Codes are stored hashed; a
 * challenge is clinic-scoped, short-lived, and consumed on successful booking.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// HMAC keyed by a server-side secret (config.otp.hashSecret) — a leaked
// otpChallenges row cannot be brute-forced offline without the secret.
function hashCode(clinicId, email, code) {
  return crypto.createHmac('sha256', config.otp.hashSecret).update(`${clinicId}:${email}:${code}`).digest('hex');
}

function windowStart() {
  return new Date(Date.now() - config.otp.throttleWindowMinutes * 60000);
}

function genCode(len) {
  let c = '';
  for (let i = 0; i < len; i += 1) c += crypto.randomInt(0, 10);
  return c;
}

function normEmail(email) {
  return String(email || '').toLowerCase().trim();
}

async function requestOtp(clinicId, emailRaw) {
  const email = normEmail(emailRaw);
  if (!EMAIL_RE.test(email)) throw new AppError(400, 'A valid email is required');

  // Throttle code requests per email+clinic so the per-challenge attempt cap can't
  // be reset by simply minting new challenges (brute-force defense, hard-rule-4 integrity).
  const recent = await OtpChallenge.find({ clinicId, email, createdAt: { $gte: windowStart() } }).sort({ createdAt: -1 });
  if (recent.length >= config.otp.maxRequestsPerWindow) {
    throw new AppError(429, 'Too many code requests. Please try again later.');
  }
  if (recent[0] && Date.now() - new Date(recent[0].createdAt).getTime() < config.otp.minRequestIntervalSeconds * 1000) {
    throw new AppError(429, 'Please wait a moment before requesting another code.');
  }

  const code = genCode(config.otp.length);
  const expiresAt = new Date(Date.now() + config.otp.ttlMinutes * 60000);
  await OtpChallenge.create({ clinicId, email, codeHash: hashCode(clinicId, email, code), expiresAt });

  await sendNotification({
    channel: 'email',
    to: email,
    subject: 'Your booking verification code',
    message: `Your verification code is ${code}. It expires in ${config.otp.ttlMinutes} minutes.`,
  });

  const res = { ok: true, expiresInMinutes: config.otp.ttlMinutes };
  // Dev convenience only (no real SMTP, non-prod): expose the code so the flow is testable.
  if (!config.isProd && !config.mail.host) res.devCode = code;
  return res;
}

async function verifyOtp(clinicId, emailRaw, code) {
  const email = normEmail(emailRaw);

  // Failure budget across ALL recent challenges for this email+clinic — re-requesting
  // a fresh code does not reset it, so the 1,000,000-code space can't be brute-forced.
  const recent = await OtpChallenge.find({ clinicId, email, createdAt: { $gte: windowStart() } });
  const totalFailures = recent.reduce((sum, c) => sum + (c.attempts || 0), 0);
  if (totalFailures >= config.otp.maxFailuresPerWindow) {
    throw new AppError(429, 'Too many attempts. Please request a new code and try again later.');
  }

  const challenge = await OtpChallenge.findOne({
    clinicId,
    email,
    consumedAt: null,
    expiresAt: { $gt: new Date() },
  }).sort({ createdAt: -1 });

  if (!challenge) throw new AppError(400, 'No active code. Request a new one.');
  if (challenge.attempts >= config.otp.maxAttempts) throw new AppError(429, 'Too many attempts. Request a new code.');

  if (challenge.codeHash !== hashCode(clinicId, email, code)) {
    challenge.attempts += 1;
    await challenge.save();
    throw new AppError(400, 'Incorrect code');
  }
  challenge.verifiedAt = new Date();
  await challenge.save();
  return { ok: true };
}

/** Atomically consume a verified, unexpired, unconsumed challenge (called at booking). */
async function consumeVerified(clinicId, emailRaw) {
  const email = normEmail(emailRaw);
  const res = await OtpChallenge.findOneAndUpdate(
    { clinicId, email, verifiedAt: { $ne: null }, consumedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { consumedAt: new Date() } },
    { sort: { createdAt: -1 }, new: true }
  );
  return !!res;
}

module.exports = { requestOtp, verifyOtp, consumeVerified };
