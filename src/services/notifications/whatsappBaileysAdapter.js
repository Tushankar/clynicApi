'use strict';

const config = require('../../config/env');

/**
 * whatsappBaileysAdapter — WhatsApp via **Baileys** (unofficial, free, local), behind the same
 * `send({ to, message })` interface as email/SMS so reminder logic never changes (§10.5).
 *
 * ⚠️ Baileys drives a REAL WhatsApp account over an unofficial connection (against WhatsApp's
 * ToS); numbers doing automated messaging can be banned. It is OPTIONAL and NON-LOAD-BEARING —
 * email is always the default/fallback channel. Enable with WHATSAPP_DRIVER=baileys.
 *
 * Pairing: the owner opens CRM → WhatsApp → Connect; we start a socket, surface the QR
 * (via getStatus().qr) for the UI to render, and persist the session under
 * BAILEYS_SESSION_DIR so later boots reconnect without re-pairing.
 *
 * @whiskeysockets/baileys is LAZY-required so a box with WHATSAPP_DRIVER=none never loads it.
 */
let sockPromise = null;

// Live connection state for the UI (CRM channel card).
const state = {
  status: 'disconnected', // disconnected | connecting | qr | connected
  qr: null, // latest QR string while pairing
  me: null, // connected WhatsApp id (number) once open
  lastError: null,
};

function getStatus() {
  if (!config.whatsapp.enabled) return { enabled: false, status: 'disabled', qr: null, me: null };
  return { enabled: true, status: state.status, qr: state.qr, me: state.me, lastError: state.lastError };
}

async function getSocket() {
  if (sockPromise) return sockPromise;
  sockPromise = (async () => {
    // eslint-disable-next-line global-require, import/no-unresolved
    const baileys = require('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    state.status = 'connecting';
    state.lastError = null;
    const { state: authState, saveCreds } = await useMultiFileAuthState(config.whatsapp.baileysSessionDir);
    const sock = makeWASocket({ auth: authState });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        state.status = 'qr';
        state.qr = qr;
        if (!config.isProd) console.log('[whatsapp:baileys] QR ready — scan from the CRM page (WhatsApp → Connect)');
      }
      if (connection === 'open') {
        state.status = 'connected';
        state.qr = null;
        state.me = sock.user?.id?.split(':')[0] || sock.user?.id || null;
        if (!config.isProd) console.log(`[whatsapp:baileys] connected as ${state.me}`);
      } else if (connection === 'close') {
        const loggedOut = lastDisconnect?.error?.output?.statusCode === DisconnectReason?.loggedOut;
        state.status = 'disconnected';
        state.qr = null;
        state.lastError = loggedOut ? 'Logged out — reconnect and scan the QR again.' : String(lastDisconnect?.error?.message || 'connection closed');
        if (loggedOut) state.me = null;
        sockPromise = null; // allow a fresh connect on next send/pairing
        if (!config.isProd) console.log(`[whatsapp:baileys] connection closed${loggedOut ? ' (logged out — re-pair from the CRM page)' : ' — will reconnect on next use'}`);
      }
    });
    return sock;
  })().catch((err) => {
    sockPromise = null;
    state.status = 'disconnected';
    state.lastError = String(err.message || err);
    throw err;
  });
  return sockPromise;
}

/** Kick off (or reuse) a connection so the UI can poll for the QR / connected state. */
async function startPairing() {
  if (!config.whatsapp.enabled) throw new Error('WhatsApp channel is not enabled (set WHATSAPP_DRIVER=baileys).');
  getSocket().catch(() => {}); // fire-and-forget; the UI polls getStatus()
  return getStatus();
}

/** Log the number out and clear in-memory state so a different number can be paired. */
async function logout() {
  if (sockPromise) {
    try {
      const sock = await sockPromise;
      await sock.logout().catch(() => {});
    } catch {
      /* ignore */
    }
  }
  sockPromise = null;
  state.status = 'disconnected';
  state.qr = null;
  state.me = null;
  return getStatus();
}

function toJid(to) {
  const num = String(to || '').replace(/[^\d]/g, ''); // digits only, E.164 without '+'
  if (!num) throw new Error('WhatsApp: missing recipient phone number');
  return `${num}@s.whatsapp.net`;
}

// ---- Anti-ban throttle + message variation --------------------------------------------------
// Baileys drives a real account; blasting many IDENTICAL messages back-to-back is the pattern that
// gets numbers restricted. So we (1) SERIALIZE outbound messages with a randomized human-like gap,
// and (2) VARY each message slightly so the same template body is never sent byte-identically to
// many recipients. Time-critical messages (OTP, "you're next") use the urgent fast-path so a
// patient is never left waiting on the queue.
const MIN_DELAY_MS = Math.max(0, Number(process.env.WHATSAPP_MIN_DELAY_MS || 5000)); // 5s
const MAX_DELAY_MS = Math.max(MIN_DELAY_MS, Number(process.env.WHATSAPP_MAX_DELAY_MS || 25000)); // 25s
const URGENT_MAX_MS = Math.max(0, Number(process.env.WHATSAPP_URGENT_MAX_MS || 2500)); // tiny jitter only
const ZWSP = String.fromCharCode(0x200b); // zero-width space — invisible to the recipient, changes the content hash

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

// Track how often each (normalized) body has gone out, purely to WARN if a raw template is being
// blasted unchanged — variation already guarantees no two sends are byte-identical.
const bodyCounts = new Map();
let bodyWindowStart = Date.now();
function noteBody(message) {
  if (Date.now() - bodyWindowStart > 6 * 3600 * 1000) { bodyCounts.clear(); bodyWindowStart = Date.now(); } // 6h window
  const key = String(message || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const n = (bodyCounts.get(key) || 0) + 1;
  bodyCounts.set(key, n);
  if (n === 50) console.warn('[whatsapp:baileys] a near-identical message has been sent 50 times — variation is on, but consider spacing campaigns further.');
}

/**
 * Make a message slightly, INVISIBLY different each send so identical template bodies don't go out
 * byte-identical to many recipients. Inserts a zero-width space at a random word gap and jitters
 * the trailing whitespace — the recipient sees no difference, but the content hash changes.
 */
function varyMessage(message) {
  let m = String(message || '');
  const gaps = [];
  for (let i = 0; i < m.length; i += 1) if (m[i] === ' ') gaps.push(i);
  if (gaps.length) {
    const at = gaps[randBetween(0, gaps.length - 1)];
    m = `${m.slice(0, at)} ${ZWSP}${m.slice(at + 1)}`;
  }
  return m.replace(/\s+$/, '') + '\n'.repeat(randBetween(0, 2));
}

const queue = [];
let draining = false;
let lastSentAt = 0;

async function rawSend(to, message) {
  const sock = await getSocket();
  noteBody(message);
  return sock.sendMessage(toJid(to), { text: varyMessage(message) });
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    while (queue.length) {
      const job = queue[0];
      // Randomized, human-like gap since the last message actually went out.
      const gap = randBetween(MIN_DELAY_MS, MAX_DELAY_MS);
      const waited = Date.now() - lastSentAt;
      if (waited < gap) await sleep(gap - waited);
      try {
        const res = await rawSend(job.to, job.message);
        lastSentAt = Date.now();
        job.resolve(res);
      } catch (err) {
        job.reject(err);
      }
      queue.shift();
    }
  } finally {
    draining = false;
  }
}

async function send({ to, message, urgent = false }) {
  if (!config.whatsapp.enabled) {
    // Guard: never silently drop. Callers should only pick 'whatsapp' when enabled; email is
    // the default channel otherwise (reminderService enforces this).
    throw new Error('WhatsApp channel is not enabled (set WHATSAPP_DRIVER=baileys).');
  }
  // Time-critical (OTP / "you're next"): send now with only a tiny jitter so we never keep a
  // waiting patient for 25s, while still avoiding perfectly-synchronous bursts.
  if (urgent) {
    if (URGENT_MAX_MS) {
      const waited = Date.now() - lastSentAt;
      if (waited < URGENT_MAX_MS) await sleep(randBetween(0, URGENT_MAX_MS - waited));
    }
    const res = await rawSend(to, message);
    lastSentAt = Date.now();
    return res;
  }
  // Everything else (campaigns, reminders, recalls, waitlist, confirmations): queue behind a
  // randomized 5–25s gap so bulk runs look human and stay well under any rate ceiling.
  return new Promise((resolve, reject) => {
    queue.push({ to, message, resolve, reject });
    drain().catch(() => {});
  });
}

/** True when the adapter can actually deliver right now (paired + open). */
function isConnected() {
  return config.whatsapp.enabled && state.status === 'connected';
}

module.exports = { send, getStatus, startPairing, logout, isConnected };
