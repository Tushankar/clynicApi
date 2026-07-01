'use strict';

/**
 * Phase 4 · Step 8 — WhatsApp channel upgrade.
 * Proves: the WhatsApp adapter works behind the shared notification interface; the reminder
 * channel is PLAN-GATED **and** only used when the channel is actually configured (cloud
 * driver) — WhatsApp for entitled+configured clinics (with a phone), email otherwise; and a
 * scheduled WhatsApp reminder delivers through the adapter.
 *
 * Runs with the cloud driver so channel selection is exercised; the network call is stubbed.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.WHATSAPP_DRIVER = 'cloud';
process.env.WHATSAPP_TOKEN = 'test-token';
process.env.WHATSAPP_PHONE_ID = '123456';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Reminder } = require('../src/models');
const reminderService = require('../src/services/reminderService');
const { sendNotification, adapters } = require('../src/services/notifications');

// Stub the actual Graph API call so no real network request is made.
let sent = [];
const realSend = adapters.whatsapp.send;
adapters.whatsapp.send = async ({ to, message }) => {
  sent.push({ to, message });
  return { stubbed: true, to };
};

let mongod;
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });
const future = (h) => new Date(Date.now() + h * 3600 * 1000);

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({ clinicId: 'org_wa_std', name: 'Std', slug: 'wastd', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_wa_basic', name: 'Basic', slug: 'wabasic', subscriptionPlan: 'basic' });
});

after(async () => {
  adapters.whatsapp.send = realSend;
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('WhatsApp sends behind the shared sendNotification interface', async () => {
  await sendNotification({ channel: 'whatsapp', to: '+91 98300 00000', message: 'Hi' });
  assert.ok(sent.some((s) => s.message === 'Hi'), 'routed through the whatsapp adapter');
  console.log('  ✓ WhatsApp routed via sendNotification');
});

test('reminder channel is plan-gated: Standard+phone+configured → WhatsApp', async () => {
  const appointment = { _id: new mongoose.Types.ObjectId(), patientId: new mongoose.Types.ObjectId(), scheduledAt: future(48), doctorName: 'Dr A' };
  const created = await reminderService.scheduleAppointmentReminders(ctx('org_wa_std'), { appointment, patient: { name: 'Rita', email: 'rita@x.com', phone: '+91 98765 43210' } });
  assert.ok(created.length >= 1);
  assert.ok(created.every((r) => r.channel === 'whatsapp'), 'Standard + phone + cloud driver → WhatsApp');
  console.log('  ✓ Standard + phone → WhatsApp reminders');
});

test('reminder channel is plan-gated: Basic → email (WhatsApp locked)', async () => {
  const appointment = { _id: new mongoose.Types.ObjectId(), patientId: new mongoose.Types.ObjectId(), scheduledAt: future(48), doctorName: 'Dr B' };
  const created = await reminderService.scheduleAppointmentReminders(ctx('org_wa_basic'), { appointment, patient: { name: 'Sam', email: 'sam@x.com', phone: '+91 90000 00000' } });
  assert.ok(created.every((r) => r.channel === 'email'), 'Basic clinic → email (not entitled to WhatsApp)');
  console.log('  ✓ Basic → email (WhatsApp plan-gated off)');
});

test('a scheduled WhatsApp reminder delivers via the adapter', async () => {
  const appointment = { _id: new mongoose.Types.ObjectId(), patientId: new mongoose.Types.ObjectId(), scheduledAt: future(48), doctorName: 'Dr C' };
  const created = await reminderService.scheduleAppointmentReminders(ctx('org_wa_std'), { appointment, patient: { name: 'Deb', phone: '+91 91111 11111' } });
  await Reminder.updateMany({ _id: { $in: created.map((r) => r._id) } }, { $set: { sendAt: new Date(Date.now() - 1000) } });
  const res = await reminderService.processDueReminders({ clinicId: 'org_wa_std' });
  assert.ok(res.sent >= 1, 'delivered via the (stubbed) whatsapp adapter');
  const one = await Reminder.findById(created[0]._id).lean();
  assert.equal(one.status, 'sent');
  assert.equal(one.channel, 'whatsapp');
  console.log('  ✓ scheduled WhatsApp reminder delivered (status sent)');
});
