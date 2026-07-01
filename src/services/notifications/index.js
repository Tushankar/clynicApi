'use strict';

const emailAdapter = require('./emailAdapter');
const smsAdapter = require('./smsAdapter');
const whatsappAdapter = require('./whatsappAdapter');

/**
 * Provider-agnostic notification service (section 10.5). All reminders/OTP go
 * through sendNotification so the channel is swappable with zero changes to
 * reminder logic. Phase 1 uses 'email'; 'sms'/'whatsapp' are interface-ready stubs.
 */
const adapters = {
  email: emailAdapter,
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
};

async function sendNotification({ channel = 'email', to, message, subject, html }) {
  const adapter = adapters[channel];
  if (!adapter) throw new Error(`No adapter for channel: ${channel}`);
  return adapter.send({ to, message, subject, html });
}

module.exports = { sendNotification, adapters, emailAdapter };
