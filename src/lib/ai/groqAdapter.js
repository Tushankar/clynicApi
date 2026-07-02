'use strict';

const config = require('../../config/env');

/**
 * Real LLM driver — Groq (OpenAI-compatible Chat Completions), default model
 * `openai/gpt-oss-120b`. Used when AI_DRIVER=groq.
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
  'Keep answers concise and plain — no markdown headings.',
].join('\n');

async function complete(userPrompt, { maxTokens = 1024 } = {}) {
  const res = await fetch(`${config.ai.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.ai.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.ai.model,
      temperature: 0.3,
      max_completion_tokens: maxTokens,
      messages: [
        { role: 'system', content: SYSTEM_RULES },
        { role: 'user', content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Groq API ${res.status}: ${detail.slice(0, 300)}`);
  }
  const data = await res.json();
  // gpt-oss puts any chain-of-thought in message.reasoning; the answer is message.content.
  return (data.choices?.[0]?.message?.content || '').trim();
}

const faqAnswer = ({ question, clinic, doctors }) =>
  complete(
    `Clinic: ${JSON.stringify({ name: clinic.name, address: clinic.address, phone: clinic.phone })}\n` +
      `Doctors: ${JSON.stringify((doctors || []).map((d) => ({ name: d.name, specialization: d.specialization, fee: d.consultationFee })))}\n\n` +
      `Patient question (answer with LOGISTICS ONLY from the data above — fees, timings, location, doctors, booking — no medical advice): ${question}`
  );

const structureSymptoms = ({ symptomsText }) =>
  complete(`Restructure the following patient-described symptoms into a neutral bullet summary FOR THE DOCTOR. Do NOT interpret, diagnose, or suggest anything — only reorganize what the patient said. Symptoms: ${symptomsText}`);

const draftVisitSummary = ({ patient, appointment, notes, prescriptions }) =>
  complete(
    `Draft a visit summary FOR THE DOCTOR to review by restating ONLY the recorded data below. Add no new clinical conclusions, diagnoses, or recommendations.\n` +
      `Patient: ${patient?.name}. Visit date: ${appointment?.scheduledAt || 'n/a'}.\n` +
      `Clinical notes: ${JSON.stringify((notes || []).map((n) => n.content))}.\n` +
      `Prescriptions on record: ${JSON.stringify((prescriptions || []).map((p) => p.items))}.`
  );

module.exports = { driver: 'groq', get model() { return config.ai.model; }, SYSTEM_RULES, faqAnswer, structureSymptoms, draftVisitSummary };
