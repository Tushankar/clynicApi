'use strict';

const { Doctor, VoiceSession } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const aiService = require('./aiService');
const publicService = require('./publicService');
const appointmentService = require('./appointmentService');
const patientService = require('./patientService');
const { looksLikeMedicalAdvice, PATIENT_AI_DISCLAIMER } = require('../lib/ai/guard');
const AppError = require('../utils/AppError');

/**
 * AI voice receptionist (§5.10 / step 9, the heaviest). Provider-agnostic: it's a text-in /
 * text-out turn handler (a slot-filling dialog). The TELEPHONY layer (Twilio/Exotel voice +
 * speech-to-text + text-to-speech) is MANUAL INFRA that calls this per utterance — see
 * docs/VOICE_RECEPTIONIST_INFRA.md.
 *
 * HARD RULE 2: the receptionist NEVER diagnoses or gives medical advice. Any medical/symptom
 * talk is deflected to "I can't advise, but I can book you with the doctor", and FAQ answers
 * come from the rule-2-guarded aiService.faq. It only: answers logistics FAQs + books visits.
 */

const MEDICAL_RE = /\b(pain|fever|sick|hurts?|symptom|symptoms|cough|cold|headache|diagnos\w*|medicine|medication|prescription|infection|rash|dizzy|nausea|vomit|bleeding)\b/i;
const BOOK_RE = /\b(book|appointment|appoint|schedule|see (?:the|a) doctor|reserve)\b/i;
const YES_RE = /\b(yes|yeah|yep|confirm|correct|sure|ok|okay)\b/i;

function ctxFor(clinic) {
  return { clinicId: clinic.clinicId, actorId: 'voice', actorRole: null };
}
function repo(ctx) {
  return tenantRepo(VoiceSession, ctx, { audit: false });
}

function doctorMenu(doctors) {
  if (!doctors.length) return 'Sorry, no doctors are available to book right now.';
  return `We have ${doctors.map((d) => d.name).join(', ')}. Which doctor would you like to see?`;
}

function matchDoctor(doctors, text) {
  const t = String(text).toLowerCase();
  const byName = doctors.find((d) => t.includes(String(d.name).toLowerCase()) || String(d.name).toLowerCase().split(/\s+/).some((w) => w.length > 2 && t.includes(w)));
  if (byName) return byName;
  return doctors.length === 1 ? doctors[0] : null;
}

function parseDate(text) {
  const t = String(text).toLowerCase().trim();
  const today = new Date();
  if (/\btoday\b/.test(t)) return today;
  if (/\btomorrow\b/.test(t)) return new Date(today.getTime() + 86400000);
  const iso = t.match(/\d{4}-\d{2}-\d{2}/);
  if (iso) {
    const d = new Date(`${iso[0]}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** One conversational turn. Returns { say, done }. */
async function handleTurn(clinic, { sessionId, text = '', callerPhone = null }) {
  if (!clinic) throw new AppError(404, 'Clinic not found');
  const ctx = ctxFor(clinic);
  const r = repo(ctx);

  let session = await r.findOne({ sessionId });
  if (!session) {
    session = await r.create({ sessionId, callerPhone, state: 'greet', collected: {}, transcript: [] });
  }
  const collected = { ...(session.collected || {}) };
  const transcript = [...(session.transcript || []), { role: 'caller', text: String(text).slice(0, 500) }];

  const doctors = await tenantRepo(Doctor, ctx).find({ isActive: true }, { sort: { name: 1 }, lean: true });
  let state = session.state;
  let say = '';
  let done = false;
  const patch = {};

  // Rule 2: if the caller talks symptoms/meds at ANY point, deflect — never advise.
  const medical = MEDICAL_RE.test(text) || looksLikeMedicalAdvice(text);

  if (state === 'greet') {
    say = `Hello, you've reached ${clinic.name}. I can share fees, timings and location, or book an appointment. How can I help? I can't give medical advice.`;
    state = 'menu';
  } else if (medical && state !== 'book_name') {
    say = "I'm not able to give medical advice or discuss symptoms — that's for the doctor. But I can book you an appointment. Would you like to book?";
    state = 'menu';
  } else if (state === 'menu') {
    if (BOOK_RE.test(text)) {
      say = doctorMenu(doctors);
      state = doctors.length ? 'book_doctor' : 'menu';
    } else {
      // Treat as a logistics FAQ (rule-2-guarded answer from aiService).
      const faq = await aiService.faq(ctx, clinic, text || 'What can you help with?');
      say = `${faq.answer} You can also say "book" to make an appointment.`;
    }
  } else if (state === 'book_doctor') {
    const doc = matchDoctor(doctors, text);
    if (!doc) {
      say = `Sorry, I didn't catch that. ${doctorMenu(doctors)}`;
    } else {
      collected.doctorId = String(doc._id);
      collected.doctorName = doc.name;
      say = `Great, ${doc.name}. What day would you like? You can say "today", "tomorrow", or a date like 2026-07-05.`;
      state = 'book_date';
    }
  } else if (state === 'book_date') {
    const date = parseDate(text);
    if (!date) {
      say = 'Please say a day like "tomorrow" or a date like 2026-07-05.';
    } else {
      const dateISO = date.toISOString().slice(0, 10);
      const { slots } = await publicService.getPublicSlots(clinic.slug, { doctorId: collected.doctorId, date: dateISO });
      const open = (slots || []).find((s) => s.available);
      if (!open) {
        say = `Sorry, there are no open slots for ${collected.doctorName} on ${dateISO}. Would you like another day?`;
      } else {
        collected.scheduledAt = open.start;
        collected.dateISO = dateISO;
        say = `The earliest opening is ${open.label} on ${dateISO} with ${collected.doctorName}. Please say your name to confirm the booking.`;
        state = 'book_name';
      }
    }
  } else if (state === 'book_name') {
    const name = String(text).trim().slice(0, 80) || 'Caller';
    // Find-or-create by caller phone (family-safe), then book (source: phone). Rule-1 scoped.
    const { patient } = await patientService.findOrCreatePatient(ctx, { name, phone: callerPhone || session.callerPhone || undefined });
    const patientId = patient._id;
    const appt = await appointmentService.book(ctx, { doctorId: collected.doctorId, patientId, scheduledAt: collected.scheduledAt, source: 'phone', reason: 'Booked via voice receptionist' });
    patch.appointmentId = appt._id;
    patch.tokenNumber = appt.tokenNumber;
    say = `You're booked with ${collected.doctorName} on ${collected.dateISO}. Your token number is ${appt.tokenNumber}. A confirmation will follow. Goodbye!`;
    state = 'done';
    done = true;
  } else {
    say = 'Thanks for calling. Goodbye!';
    done = true;
  }

  transcript.push({ role: 'assistant', text: say });
  await r.updateById(session._id, { state, collected, transcript: transcript.slice(-40), ...patch });
  return { say, done, state, disclaimer: PATIENT_AI_DISCLAIMER };
}

module.exports = { handleTurn };
