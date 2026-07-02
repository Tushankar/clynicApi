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

async function send({ to, message }) {
  if (!config.whatsapp.enabled) {
    // Guard: never silently drop. Callers should only pick 'whatsapp' when enabled; email is
    // the default channel otherwise (reminderService enforces this).
    throw new Error('WhatsApp channel is not enabled (set WHATSAPP_DRIVER=baileys).');
  }
  const sock = await getSocket();
  return sock.sendMessage(toJid(to), { text: String(message || '') });
}

/** True when the adapter can actually deliver right now (paired + open). */
function isConnected() {
  return config.whatsapp.enabled && state.status === 'connected';
}

module.exports = { send, getStatus, startPairing, logout, isConnected };
