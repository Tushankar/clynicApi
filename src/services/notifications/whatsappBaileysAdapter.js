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
 * @whiskeysockets/baileys is LAZY-required so a box without it (or with WHATSAPP_DRIVER=none)
 * never loads it. First run prints a QR code in the API logs to pair the device; the session is
 * persisted under BAILEYS_SESSION_DIR (gitignored) so later boots reconnect without re-pairing.
 */
let sockPromise = null;

async function getSocket() {
  if (sockPromise) return sockPromise;
  sockPromise = (async () => {
    // eslint-disable-next-line global-require, import/no-unresolved
    const baileys = require('@whiskeysockets/baileys');
    const makeWASocket = baileys.default || baileys.makeWASocket;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(config.whatsapp.baileysSessionDir);
    const sock = makeWASocket({ auth: state, printQRInTerminal: true });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', (u) => {
      const { connection, lastDisconnect } = u;
      if (connection === 'close') {
        const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason?.loggedOut;
        sockPromise = null; // allow a fresh connect on next send
        if (!config.isProd) console.log(`[whatsapp:baileys] connection closed${shouldReconnect ? ' — will reconnect on next send' : ' (logged out — delete the session dir and re-pair)'}`);
      } else if (connection === 'open' && !config.isProd) {
        console.log('[whatsapp:baileys] connected');
      }
    });
    return sock;
  })().catch((err) => {
    sockPromise = null;
    throw err;
  });
  return sockPromise;
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

module.exports = { send };
