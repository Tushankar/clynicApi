'use strict';

/**
 * The official WhatsApp Business Cloud API adapter was intentionally REMOVED — Baileys is the
 * only WhatsApp adapter in this deployment. This file remains as a back-compat re-export so any
 * stray `require('./whatsappAdapter')` still resolves to the Baileys implementation.
 */
module.exports = require('./whatsappBaileysAdapter');
