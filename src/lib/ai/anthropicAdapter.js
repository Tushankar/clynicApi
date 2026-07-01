'use strict';

const config = require('../../config/env');

/**
 * Real LLM driver (Anthropic Claude), lazy-loaded so the SDK is only required when
 * AI_DRIVER=anthropic (never in the dev/test sandbox, which uses the mock driver).
 *
 * Rule 2 is enforced in TWO places for defense in depth:
 *   1. Here — a strict system prompt that forbids diagnosis/prescription/medical advice.
 *   2. Above — the guard.js output scan + the doctor-approval workflow (aiService),
 *      which apply regardless of what the model returns.
 */

const SYSTEM_RULES = [
  'You are a clinic operations assistant. You are NOT a doctor and MUST NOT practise medicine.',
  'ABSOLUTE RULES:',
  '- NEVER diagnose. Never tell anyone what condition they have or might have.',
  '- NEVER prescribe or recommend medicines, doses, or treatments.',
  '- NEVER give medical advice directly to a patient.',
  'You MAY: answer logistics FAQs (fees, timings, location, services); restructure a',
  "patient's own words into a neutral intake summary for the doctor; and restate a",
  "doctor's own recorded notes into a draft summary FOR THE DOCTOR to review and approve.",
  'If asked for anything diagnostic or prescriptive, refuse and suggest consulting the doctor.',
].join('\n');

let client = null;
function getClient() {
  if (client) return client;
  // eslint-disable-next-line global-require
  const Anthropic = require('@anthropic-ai/sdk'); // only reached when driver=anthropic
  client = new Anthropic({ apiKey: config.ai.apiKey });
  return client;
}

async function complete(userPrompt, { maxTokens = 700 } = {}) {
  const resp = await getClient().messages.create({
    model: config.ai.model,
    max_tokens: maxTokens,
    system: SYSTEM_RULES,
    messages: [{ role: 'user', content: userPrompt }],
  });
  return resp.content?.map((b) => b.text).join('') || '';
}

const faqAnswer = ({ question, clinic, doctors }) =>
  complete(`Clinic: ${JSON.stringify({ name: clinic.name, address: clinic.address, phone: clinic.phone })}\nDoctors: ${JSON.stringify(doctors)}\n\nPatient question (answer with LOGISTICS ONLY, no medical advice): ${question}`);

const structureSymptoms = ({ symptomsText }) =>
  complete(`Restructure the following patient-described symptoms into a neutral bullet summary FOR THE DOCTOR. Do NOT interpret, diagnose, or suggest anything. Symptoms: ${symptomsText}`);

const draftVisitSummary = ({ patient, appointment, notes, prescriptions }) =>
  complete(`Draft a visit summary FOR THE DOCTOR to review by restating ONLY the recorded data below. Add no new clinical conclusions. Patient: ${patient?.name}. Notes: ${JSON.stringify(notes?.map((n) => n.content))}. Prescriptions: ${JSON.stringify(prescriptions?.map((p) => p.items))}.`);

module.exports = { driver: 'anthropic', get model() { return config.ai.model; }, SYSTEM_RULES, faqAnswer, structureSymptoms, draftVisitSummary };
