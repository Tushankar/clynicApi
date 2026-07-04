'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');

/**
 * otpChallenges — email-OTP verification for public booking (section 3 / 10.5).
 * The code is stored hashed (never plaintext). A challenge is clinic-scoped (by the
 * booking page's slug → clinicId), expires quickly, and is consumed on successful
 * booking. A TTL index purges expired challenges automatically.
 */
const otpChallengeSchema = new mongoose.Schema(
  {
    // Identity is EITHER an email OR a phone (normalized last-10-digits) — so patients without an
    // email can verify via WhatsApp/SMS. codeHash is HMAC-SHA256(clinicId:identifier:code).
    email: { type: String, lowercase: true, trim: true, default: null },
    phone: { type: String, trim: true, default: null },
    channel: { type: String, enum: ['email', 'whatsapp', 'sms'], default: 'email' },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    verifiedAt: { type: Date, default: null },
    consumedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

clinicScoped(otpChallengeSchema);
otpChallengeSchema.index({ clinicId: 1, email: 1, createdAt: -1 });
otpChallengeSchema.index({ clinicId: 1, phone: 1, createdAt: -1 });
// TTL: Mongo removes the doc ~when expiresAt passes (cleanup only; logic checks expiry too).
otpChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpChallenge', otpChallengeSchema);
