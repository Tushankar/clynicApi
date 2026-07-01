'use strict';

/**
 * Mock AI driver — deterministic + rule-2-safe by construction. Used in dev/test so the
 * AI features (and their safety guarantees) are fully exercisable without a live LLM.
 * It NEVER produces diagnosis/advice: FAQ answers are pure clinic logistics, symptom
 * intake only restructures what the patient typed, visit summaries only restate the
 * doctor's own recorded data. Production swaps in the anthropic driver behind this same
 * interface — the guardrail + doctor-approval workflow apply to both identically.
 */

const DURATION_RE = /\b(\d+\s?(?:day|days|week|weeks|month|months|year|years|hour|hours))\b/i;

function faqAnswer({ question = '', clinic = {}, doctors = [] }) {
  const q = String(question).toLowerCase();
  const name = clinic.name || 'our clinic';

  if (/\b(fee|fees|price|cost|charge|charges|how much)\b/.test(q)) {
    const withFees = doctors.filter((d) => Number(d.consultationFee) > 0);
    if (withFees.length) {
      return `Consultation fees at ${name}: ${withFees.map((d) => `${d.name} — ₹${d.consultationFee}`).join('; ')}.`;
    }
    return `Please contact ${name}${clinic.phone ? ` at ${clinic.phone}` : ''} for current consultation fees.`;
  }
  if (/\b(where|location|address|reach|direction|map)\b/.test(q)) {
    return clinic.address ? `${name} is located at ${clinic.address}.` : `Please call ${name}${clinic.phone ? ` at ${clinic.phone}` : ''} for directions.`;
  }
  if (/\b(time|timing|timings|hour|hours|open|when|schedule)\b/.test(q)) {
    return `For current timings and availability, you can pick a doctor and see open slots on the booking page${clinic.phone ? `, or call ${clinic.phone}` : ''}.`;
  }
  if (/\b(doctor|doctors|specialist|service|services|treat|department)\b/.test(q)) {
    if (doctors.length) return `${name} has: ${doctors.map((d) => `${d.name}${d.specialization ? ` (${d.specialization})` : ''}`).join(', ')}.`;
    return `Please contact ${name} to learn about our doctors and services.`;
  }
  if (/\b(book|appointment|slot|schedule a|register)\b/.test(q)) {
    return `You can book an appointment on this page: choose a doctor, pick a date and an open slot, and verify your email to confirm.`;
  }
  // Default: logistics-only, explicitly non-medical.
  return `Thanks for your question. I can help with fees, timings, location, doctors, and booking at ${name}. For anything medical, our doctor will help you during the visit.`;
}

function structureSymptoms({ symptomsText = '' }) {
  const text = String(symptomsText).trim();
  const duration = (text.match(DURATION_RE) || [])[1];
  const firstSentence = text.split(/[.\n]/)[0]?.trim();
  const lines = [
    'Patient-reported intake (for doctor review — not a diagnosis):',
    `• Chief concern (as described): ${firstSentence || '—'}`,
    `• Reported duration: ${duration || 'not specified'}`,
    `• Full description: ${text || '—'}`,
  ];
  return lines.join('\n');
}

function draftVisitSummary({ patient = {}, appointment = {}, notes = [], prescriptions = [] }) {
  const noteText = notes.map((n) => n.content).filter(Boolean).slice(0, 3).join(' | ') || 'No clinical notes recorded.';
  const rx = prescriptions
    .flatMap((p) => (p.items || []).map((i) => `${i.drug}${i.dose ? ` ${i.dose}` : ''}`))
    .filter(Boolean)
    .slice(0, 10);
  const lines = [
    `Draft visit summary for doctor review — ${patient.name || 'patient'}${appointment.scheduledAt ? ` (${new Date(appointment.scheduledAt).toDateString()})` : ''}.`,
    `Recorded by the clinician during this visit: ${noteText}`,
    `Medications on record: ${rx.length ? rx.join(', ') : 'none recorded'}.`,
    'This is a restatement of the doctor’s recorded data for convenience. It contains no new diagnosis or recommendation and must be reviewed and approved by the doctor.',
  ];
  return lines.join('\n');
}

module.exports = { driver: 'mock', model: 'mock-clinical-1', faqAnswer, structureSymptoms, draftVisitSummary };
