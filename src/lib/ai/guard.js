'use strict';

/**
 * ============================================================================
 *  AI SAFETY GUARDRAIL — HARD RULE 2: AI NEVER DIAGNOSES.
 * ============================================================================
 *
 * This module is the single chokepoint that makes rule 2 STRUCTURAL rather than
 * a property of any particular model. Every AI output in the product flows through
 * here, so the guarantees hold no matter which driver (mock / anthropic) produced it:
 *
 *   1. DISCLAIMER — withDisclaimer() attaches a not-medical-advice notice to every output.
 *   2. NO DIAGNOSIS/ADVICE TO PATIENTS — assertNoMedicalAdvice() scans generated text for
 *      diagnostic/prescriptive language; patient-facing generation REFUSES (safe fallback)
 *      if it trips, so even a misbehaving model can never emit a diagnosis to a patient.
 *   3. DOCTOR APPROVAL — enforced by the AiDraft workflow (aiService), not here: clinical
 *      output is a draft that a doctor must explicitly approve before it is saved/used.
 *
 * The disclaimer text is a product constant so it appears identically everywhere.
 */

const AI_DISCLAIMER =
  'AI-generated — not medical advice. This does not diagnose or prescribe. ' +
  'A qualified doctor must review and approve any clinical content before it is used.';

const PATIENT_AI_DISCLAIMER =
  'This assistant shares clinic information and passes what you tell us to your doctor. ' +
  'It cannot diagnose, prescribe, or give medical advice. For medical concerns, please consult the doctor.';

// Phrases that would constitute a diagnosis / prescription / direct medical advice to a
// patient. Deliberately broad — false positives fail safe (we refuse), which is the
// correct bias for rule 2. Used to gate PATIENT-FACING generation and to FLAG clinical
// drafts for extra doctor scrutiny.
const DIAGNOSIS_PATTERNS = [
  /\byou (?:have|are suffering from|are experiencing|likely have|probably have|may have|might have)\b/i,
  /\b(?:diagnos(?:is|ed|e)|it (?:is|could be|might be|looks like) (?:a|an)\b)/i,
  /\byour (?:condition|diagnosis|disease) is\b/i,
  /\b(?:you should|you must|i recommend(?: that you)?|please) (?:take|start|stop|use|apply|inject|consume)\b/i,
  /\b(?:take|start|increase|decrease|stop) \d+\s?(?:mg|ml|mcg|g|tablet|tablets|capsule|dose|doses)\b/i,
  /\b(?:prescrib(?:e|ing|ed)|dosage|dose (?:is|should be))\b/i,
  /\b(?:this (?:medicine|drug|antibiotic|tablet)|take this) (?:will|should|to)\b/i,
];

function looksLikeMedicalAdvice(text) {
  const s = String(text || '');
  return DIAGNOSIS_PATTERNS.some((re) => re.test(s));
}

/** Append the disclaimer once (idempotent). */
function withDisclaimer(text, disclaimer = AI_DISCLAIMER) {
  const s = String(text || '').trim();
  if (s.includes(disclaimer)) return s;
  return `${s}\n\n— ${disclaimer}`;
}

/**
 * Gate for PATIENT-FACING output. Returns a safe result: if the model produced anything
 * that reads like diagnosis/advice, we DROP it and return a refusal instead of the text.
 * Never throws to the patient — always returns something safe + disclaimered.
 */
function safePatientText(text, { fallback } = {}) {
  const safeFallback =
    fallback ||
    "I can help with clinic information (fees, timings, location, services) and pass your symptoms to the doctor, but I can't give medical advice. Please consult the doctor for anything clinical.";
  if (looksLikeMedicalAdvice(text)) {
    return { text: withDisclaimer(safeFallback, PATIENT_AI_DISCLAIMER), blocked: true };
  }
  return { text: withDisclaimer(String(text || '').trim(), PATIENT_AI_DISCLAIMER), blocked: false };
}

module.exports = {
  AI_DISCLAIMER,
  PATIENT_AI_DISCLAIMER,
  looksLikeMedicalAdvice,
  withDisclaimer,
  safePatientText,
};
