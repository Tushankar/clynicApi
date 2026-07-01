'use strict';

/**
 * Centralized environment configuration + validation.
 * Loads .env once and exposes a frozen, typed config object.
 * Fail fast on misconfiguration rather than at the first request.
 */
require('dotenv').config();
const crypto = require('crypto');

const NODE_ENV = (process.env.NODE_ENV || 'development').toLowerCase().trim();
const isProd = NODE_ENV === 'production';
const isDev = NODE_ENV === 'development';
const isLocalEnv = NODE_ENV === 'development' || NODE_ENV === 'test';
const DEV_AUTH = process.env.DEV_AUTH === 'true';

// Payments driver — fail closed. Default 'mock' only in local/dev; any other env must
// set it explicitly, and 'mock' (local gateway + hardcoded dev secrets) is FORBIDDEN
// outside development/test. Mirrors the DEV_AUTH safety rail.
const PAYMENTS_DRIVER = (process.env.PAYMENTS_DRIVER || (isLocalEnv ? 'mock' : '')).toLowerCase().trim();
if (!['mock', 'razorpay'].includes(PAYMENTS_DRIVER)) {
  throw new Error(`[env] PAYMENTS_DRIVER must be 'mock' or 'razorpay' (got '${process.env.PAYMENTS_DRIVER ?? ''}'). Set it explicitly outside development/test.`);
}
if (PAYMENTS_DRIVER === 'mock' && !isLocalEnv) {
  throw new Error(`[env] PAYMENTS_DRIVER='mock' is only permitted when NODE_ENV is development/test (got '${NODE_ENV}'). The mock gateway + dev secrets must never run in a shared/production environment.`);
}

// AI driver — fail closed (hard rule 2 lives ABOVE the driver: the guardrail + doctor-approval
// workflow apply regardless). 'mock' = a deterministic, rule-2-safe local model for dev/test;
// 'anthropic' = a real LLM (requires a key). 'mock' is FORBIDDEN outside development/test.
const AI_DRIVER = (process.env.AI_DRIVER || (isLocalEnv ? 'mock' : '')).toLowerCase().trim();
if (!['mock', 'anthropic'].includes(AI_DRIVER)) {
  throw new Error(`[env] AI_DRIVER must be 'mock' or 'anthropic' (got '${process.env.AI_DRIVER ?? ''}'). Set it explicitly outside development/test.`);
}
if (AI_DRIVER === 'mock' && !isLocalEnv) {
  throw new Error(`[env] AI_DRIVER='mock' is only permitted when NODE_ENV is development/test (got '${NODE_ENV}').`);
}

// Hard safety rail (hard rule 4 — RBAC integrity): the dev auth header bypass
// must never be reachable in any remote/shared environment. FAIL CLOSED — allow
// it ONLY for explicitly-local env labels. Anything else (production, staging,
// 'prod', a typo, etc.) refuses to boot rather than silently exposing the bypass.
const DEV_AUTH_ALLOWED_ENVS = new Set(['development', 'test']);
if (DEV_AUTH && !DEV_AUTH_ALLOWED_ENVS.has(NODE_ENV)) {
  throw new Error(
    `[env] DEV_AUTH=true is only permitted when NODE_ENV is one of ` +
      `${[...DEV_AUTH_ALLOWED_ENVS].join(', ')} (got '${NODE_ENV}'). ` +
      'The dev auth header bypass must never be reachable in any remote/shared environment.'
  );
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`[env] Missing required environment variable: ${name}`);
  }
  return value;
}

// Clerk keys are required unless we are explicitly in DEV_AUTH mode (non-prod),
// where the API is exercised without a real Clerk session.
function clerkKey(name) {
  if (DEV_AUTH) return process.env[name] || '';
  return required(name);
}

const config = Object.freeze({
  nodeEnv: NODE_ENV,
  isProd,
  isDev,
  port: Number(process.env.PORT || 4000),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/clinic_saas',
  clerk: {
    secretKey: clerkKey('CLERK_SECRET_KEY'),
    publishableKey: clerkKey('CLERK_PUBLISHABLE_KEY'),
  },
  devAuth: DEV_AUTH,

  // Redis + BullMQ for reminder scheduling (optional). Without it, reminders are
  // persisted and processed by the manual processor / dev poller instead of a worker.
  redisUrl: process.env.REDIS_URL || null,

  // Email (Nodemailer). Without SMTP creds we fall back to a JSON transport that
  // "sends" to the log — enough to verify reminders + OTP in dev (10.5).
  mail: {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.MAIL_FROM || 'Clinic OS <no-reply@clinic-os.local>',
  },

  // Where the public booking page lives (for shareable links / QR codes).
  publicWebUrl: process.env.PUBLIC_WEB_URL || 'http://localhost:5173',

  // Private medical-file storage (hard rule 3). Files are NEVER public; access is
  // via short-lived signed URLs only. 'local' = private disk (dev); 's3' = private bucket.
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    localDir: process.env.PRIVATE_UPLOAD_DIR || '.private-uploads',
    s3Bucket: process.env.S3_BUCKET || '',
    s3Region: process.env.S3_REGION || '',
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 15 * 1024 * 1024), // 15MB
  },
  // HMAC secret + TTL for signed file URLs. MUST be stable + shared across instances,
  // or URLs minted on one process/replica fail to verify on another. Required outside
  // local/dev (a per-boot random key is fine only for development/test).
  fileSigningSecret: process.env.FILE_SIGNING_SECRET || (isLocalEnv ? crypto.randomBytes(32).toString('hex') : required('FILE_SIGNING_SECRET')),
  fileUrlTtlSeconds: Number(process.env.FILE_URL_TTL_SECONDS || 120),

  // Payments (Razorpay). 'mock' = local gateway using the SAME HMAC-SHA256 signature
  // scheme as Razorpay, so server-side verification + idempotency are real and testable
  // without live keys. 'razorpay' requires real keys.
  payments: {
    driver: PAYMENTS_DRIVER,
    currency: process.env.PAYMENTS_CURRENCY || 'INR',
    keyId: PAYMENTS_DRIVER === 'razorpay' ? required('RAZORPAY_KEY_ID') : 'rzp_test_mock',
    keySecret: PAYMENTS_DRIVER === 'razorpay' ? required('RAZORPAY_KEY_SECRET') : 'rzp_mock_secret_dev',
    webhookSecret: PAYMENTS_DRIVER === 'razorpay' ? required('RAZORPAY_WEBHOOK_SECRET') : 'whsec_mock_dev',
  },

  // AI assistant (§5.10, hard rule 2 — NEVER diagnoses). The guardrail (disclaimer on every
  // output + diagnosis/advice blocker) and the doctor-approval workflow are enforced in code,
  // independent of the driver. 'mock' is a safe deterministic local model; 'anthropic' is real.
  ai: {
    driver: AI_DRIVER,
    apiKey: AI_DRIVER === 'anthropic' ? required('ANTHROPIC_API_KEY') : '',
    model: process.env.AI_MODEL || 'claude-sonnet-5',
  },

  // Platform owner(s) — the only identities allowed cross-clinic super-admin analytics.
  superAdminIds: (process.env.SUPER_ADMIN_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  // Signs patient-portal sessions (issued after email OTP).
  patientSessionSecret: process.env.PATIENT_SESSION_SECRET || (isLocalEnv ? crypto.randomBytes(32).toString('hex') : required('PATIENT_SESSION_SECRET')),
  patientSessionTtlHours: Number(process.env.PATIENT_SESSION_TTL_HOURS || 24),

  otp: {
    length: 6,
    ttlMinutes: Number(process.env.OTP_TTL_MINUTES || 10),
    maxAttempts: 5, // per single challenge
    // HMAC key so a leaked otpChallenges row can't be brute-forced offline.
    // Set OTP_HASH_SECRET in prod; a per-boot random key is fine for dev (10-min TTL).
    hashSecret: process.env.OTP_HASH_SECRET || (isLocalEnv ? crypto.randomBytes(32).toString('hex') : required('OTP_HASH_SECRET')),
    // Throttling that survives re-requesting codes (defeats brute-force across challenges).
    throttleWindowMinutes: 15,
    maxRequestsPerWindow: 5, // new codes per email+clinic / window
    minRequestIntervalSeconds: 30, // min gap between code requests
    maxFailuresPerWindow: 10, // failed verifies per email+clinic / window before lockout
  },
});

module.exports = config;
