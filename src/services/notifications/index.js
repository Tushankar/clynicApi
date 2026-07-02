'use strict';

const emailAdapter = require('./emailAdapter');
const smsAdapter = require('./smsAdapter');
const whatsappAdapter = require('./whatsappBaileysAdapter');
const config = require('../../config/env');

/**
 * Provider-agnostic notification service (§10.5). All reminders/OTP go through
 * sendNotification so the channel is swappable with zero changes to feature logic.
 * Email is the default channel (config.notify.defaultChannel); WhatsApp (Baileys) is an
 * optional adapter; SMS is an interface-ready stub. NO official WhatsApp Business API.
 */
const adapters = {
  email: emailAdapter,
  sms: smsAdapter,
  whatsapp: whatsappAdapter,
};

async function sendNotification({ channel = config.notify.defaultChannel, to, message, subject, html, attachments } = {}) {
  const adapter = adapters[channel];
  if (!adapter) throw new Error(`No adapter for channel: ${channel}`);
  return adapter.send({ to, message, subject, html, attachments });
}

module.exports = { sendNotification, adapters, emailAdapter };
