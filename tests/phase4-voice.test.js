'use strict';

/**
 * Phase 4 · Step 9 — AI voice receptionist.
 * Proves (via the provider-agnostic text-in/text-out webhook): it's Premium/AI-gated; it books
 * an appointment end-to-end over a dialog; and HARD RULE 2 holds — it deflects symptom/medical
 * talk and never diagnoses or advises.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.AI_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Doctor, Appointment, Patient } = require('../src/models');
const { createApp } = require('../src/app');
const guard = require('../src/lib/ai/guard');

let mongod;
let server;
let base;

const ALL_DAYS = { sun: [{ start: '10:00', end: '16:00' }], mon: [{ start: '10:00', end: '16:00' }], tue: [{ start: '10:00', end: '16:00' }], wed: [{ start: '10:00', end: '16:00' }], thu: [{ start: '10:00', end: '16:00' }], fri: [{ start: '10:00', end: '16:00' }], sat: [{ start: '10:00', end: '16:00' }] };

async function voice(slug, body) {
  const res = await fetch(`${base}/api/public/c/${slug}/voice`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Doctor.init(), Appointment.init(), Patient.init()]);
  await Clinic.create({ clinicId: 'org_voice', name: 'Voice Clinic', slug: 'voicec', subscriptionPlan: 'premium', phone: '033-1' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'voicestd', subscriptionPlan: 'standard' });
  await new Doctor({ clinicId: 'org_voice', name: 'Dr Rao', specialization: 'Dentist', availability: ALL_DAYS, slotDurationMinutes: 30, isActive: true }).save();
  const app = createApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('(b) voice is AI/Premium-gated (Standard clinic → 404 not available)', async () => {
  const res = await voice('voicestd', { sessionId: 'c0', text: 'hello' });
  assert.equal(res.status, 404);
  console.log('  ✓ (b) voice receptionist gated by the clinic AI plan');
});

test('(a) rule 2: the receptionist deflects symptoms and never diagnoses', async () => {
  const greet = await voice('voicec', { sessionId: 'c1', text: '', callerPhone: '+919800000001' });
  assert.match(greet.body.say, /Voice Clinic/);
  assert.match(greet.body.say, /can.?t give medical advice/i);

  const medical = await voice('voicec', { sessionId: 'c1', text: 'I have chest pain and fever, what should I take?' });
  assert.match(medical.body.say, /not able to give medical advice|can.?t give medical advice/i);
  assert.equal(guard.looksLikeMedicalAdvice(medical.body.say), false, 'no diagnosis/advice in the reply');
  console.log('  ✓ (a) voice deflects medical talk, never diagnoses');
});

test('(a)+(c) books an appointment end-to-end over a dialog', async () => {
  const sid = 'c2';
  await voice('voicec', { sessionId: sid, text: '', callerPhone: '+919800000002' }); // greet
  const menu = await voice('voicec', { sessionId: sid, text: 'I want to book an appointment' });
  assert.match(menu.body.say, /Dr Rao/, 'offers the doctor');

  const dr = await voice('voicec', { sessionId: sid, text: 'Dr Rao' });
  assert.match(dr.body.say, /what day/i);

  const date = await voice('voicec', { sessionId: sid, text: 'tomorrow' });
  assert.match(date.body.say, /say your name to confirm/i, 'found a slot and asks for name');

  const done = await voice('voicec', { sessionId: sid, text: 'Anil Kumar' });
  assert.equal(done.body.done, true);
  assert.match(done.body.say, /token number is \d+/i, 'gives a token');

  // An appointment + patient were actually created for this clinic (source: phone).
  const appts = await Appointment.find({ clinicId: 'org_voice', source: 'phone' }).lean();
  assert.equal(appts.length, 1, 'exactly one appointment booked via voice');
  const patient = await Patient.findById(appts[0].patientId).lean();
  assert.equal(patient.phone, '+919800000002', 'patient created/keyed by caller phone');
  console.log('  ✓ (a)+(c) voice books end-to-end (appointment + patient, tenant-scoped)');
});
