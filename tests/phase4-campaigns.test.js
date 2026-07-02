'use strict';

/**
 * CRM campaign automations (§5.13) — birthday + follow-up.
 * Proves: due patients get the professional template on EVERY available channel (email +
 * stubbed WhatsApp at the same time); re-running the tick never double-sends (idempotent);
 * Basic clinics are skipped (plan gate); every send lands in the communications log; and
 * the branded HTML + placeholders render correctly.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.AI_DRIVER = 'mock';
process.env.WHATSAPP_DRIVER = 'baileys';
process.env.SMTP_HOST = ''; // force the dev email sink — tests must never hit real SMTP

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Patient, MessageLog } = require('../src/models');
const { adapters, emailAdapter } = require('../src/services/notifications');
const campaignService = require('../src/services/campaignService');
const templates = require('../src/lib/comms/templates');

// Stub WhatsApp: report connected + capture sends (no real socket).
const waSent = [];
adapters.whatsapp.send = async ({ to, message }) => {
  waSent.push({ to, message });
  return { stubbed: true };
};
adapters.whatsapp.isConnected = () => true;

let mongod;
const now = new Date();

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({
    clinicId: 'org_camp',
    name: 'Campaign Clinic',
    slug: 'camp1',
    phone: '033-1234-5678',
    subscriptionPlan: 'standard', // Standard HAS automations (default templates)
    crmSettings: { birthdayEnabled: true, followupEnabled: true, sendHour: 0 },
  });
  await Clinic.create({
    clinicId: 'org_camp_basic',
    name: 'Basic Clinic',
    slug: 'campbasic',
    subscriptionPlan: 'basic',
    crmSettings: { birthdayEnabled: true, followupEnabled: true, sendHour: 0 },
  });

  const bday = new Date(1990, now.getMonth(), now.getDate()); // birthday today
  await Patient.create({ clinicId: 'org_camp', patientCode: 'C0001', name: 'Bday Both', email: 'bday@x.com', phone: '+91 90000 00001', dob: bday });
  await Patient.create({ clinicId: 'org_camp', patientCode: 'C0002', name: 'Bday EmailOnly', email: 'bday2@x.com', dob: bday });
  await Patient.create({ clinicId: 'org_camp', patientCode: 'C0003', name: 'Not Today', email: 'no@x.com', dob: new Date(1990, (now.getMonth() + 3) % 12, 5) });
  await Patient.create({ clinicId: 'org_camp', patientCode: 'C0004', name: 'FollowUp Due', email: 'fup@x.com', followUpAt: new Date(now.getTime() + 3600 * 1000) });
  // Basic clinic patient with a birthday — must be SKIPPED by the plan gate.
  await Patient.create({ clinicId: 'org_camp_basic', patientCode: 'C0005', name: 'Basic Bday', email: 'basic@x.com', dob: bday });
});

after(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('birthday + follow-up campaigns send on email AND WhatsApp; Basic is plan-gated out', async () => {
  emailAdapter.clearSentLog();
  waSent.length = 0;

  const res = await campaignService.runDueCampaigns(now);
  assert.equal(res.clinics, 1, 'only the entitled clinic ran (Basic skipped by CRM_AUTOMATION gate)');
  assert.equal(res.birthday.sent, 2, 'both birthday patients reached');
  assert.equal(res.followup.sent, 1, 'follow-up-due patient reached');

  const emails = emailAdapter.getSentLog();
  assert.ok(emails.some((e) => e.to === 'bday@x.com'), 'birthday email to dual-channel patient');
  assert.ok(emails.some((e) => e.to === 'bday2@x.com'), 'birthday email to email-only patient');
  assert.ok(emails.some((e) => e.to === 'fup@x.com'), 'follow-up email sent');
  assert.ok(!emails.some((e) => e.to === 'basic@x.com'), 'Basic clinic patient NOT emailed');
  assert.ok(!emails.some((e) => e.to === 'no@x.com'), 'non-birthday patient NOT emailed');

  // Dual channel: the patient with a phone ALSO got a WhatsApp message (same campaign).
  assert.ok(waSent.some((w) => w.to === '+91 90000 00001'), 'WhatsApp sent alongside email');

  // Subject uses the professional default template with placeholders filled.
  const bdayMail = emails.find((e) => e.to === 'bday@x.com');
  assert.ok(bdayMail.subject.includes('Happy birthday') && bdayMail.subject.includes('Campaign Clinic'), 'template subject rendered');
  console.log('  ✓ campaigns: 2 birthday + 1 follow-up; email+WhatsApp both; Basic skipped');
});

test('re-running the tick is idempotent — nobody is messaged twice in a day', async () => {
  emailAdapter.clearSentLog();
  waSent.length = 0;
  const res = await campaignService.runDueCampaigns(now);
  assert.equal(res.birthday.sent, 0, 'no birthday re-sends');
  assert.equal(res.followup.sent, 0, 'no follow-up re-sends');
  assert.equal(emailAdapter.getSentLog().length, 0, 'no duplicate emails');
  assert.equal(waSent.length, 0, 'no duplicate WhatsApp messages');
  console.log('  ✓ idempotent: second tick sends nothing');
});

test('every send is recorded in the communications log (template + channel + system actor)', async () => {
  const logs = await MessageLog.find({ clinicId: 'org_camp', status: 'sent' }).lean();
  const byTemplate = logs.reduce((m, l) => ((m[l.template] = (m[l.template] || 0) + 1), m), {});
  assert.equal(byTemplate.birthday, 3, '2 birthday emails + 1 birthday WhatsApp logged');
  assert.equal(byTemplate.followup, 1, 'follow-up email logged');
  assert.ok(logs.every((l) => l.sentBy === 'system'), 'automated sends attributed to system');
  const channels = new Set(logs.map((l) => l.channel));
  assert.ok(channels.has('email') && channels.has('whatsapp'), 'both channels logged');
  console.log('  ✓ communications log: birthday×3 (email+wa), followup×1, sentBy=system');
});

test('branded HTML template renders placeholders + footer disclaimer (rule 2 tone)', () => {
  const clinic = { name: 'Campaign Clinic', phone: '033-1234-5678', crmSettings: {} };
  const out = templates.render(clinic, 'birthday', { name: 'Asha Verma' });
  assert.ok(out.subject.includes('Asha Verma') || out.text.includes('Asha Verma'), 'patient name filled');
  assert.ok(out.text.includes('Campaign Clinic'), 'clinic name filled');
  assert.ok(out.html.includes('<!doctype html>') && out.html.includes('Campaign Clinic'), 'branded HTML shell');
  assert.ok(out.html.includes('not medical advice'), 'footer disclaimer present');
  assert.ok(!out.text.includes('{{'), 'no unfilled placeholders');
  console.log('  ✓ professional HTML template renders clean');
});
