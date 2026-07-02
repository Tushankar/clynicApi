'use strict';

const config = require('../../config/env');
const mockAdapter = require('./mockAdapter');
const anthropicAdapter = require('./anthropicAdapter');
const groqAdapter = require('./groqAdapter');
const guard = require('./guard');

/**
 * AI facade (§5.10). Selects the configured driver; the guardrail (guard.js) and the
 * doctor-approval workflow (aiService) sit ABOVE this so hard rule 2 holds for any driver.
 */
const adapter =
  config.ai.driver === 'groq'
    ? groqAdapter
    : config.ai.driver === 'anthropic'
    ? anthropicAdapter
    : mockAdapter;

module.exports = {
  driver: adapter.driver,
  get model() {
    return adapter.model;
  },
  faqAnswer: (args) => adapter.faqAnswer(args),
  structureSymptoms: (args) => adapter.structureSymptoms(args),
  draftVisitSummary: (args) => adapter.draftVisitSummary(args),
  guard,
};
