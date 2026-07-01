'use strict';

/**
 * Phase 1 verification — proves the four checks at the end of section 14 against a
 * real in-memory MongoDB + an in-process Socket.IO server, exercising the same
 * services the routes use:
 *
 *   (a) public-page booking with email OTP → appointment + token; 24h/2h reminder
 *       jobs scheduled and the email adapter sends in dev.
 *   (b) reception registers a walk-in, sees today's appointments, manages the queue;
 *       the TV display updates live via Socket.IO.
 *   (c) hard rules hold on new collections: tenant isolation, soft delete, audit log,
 *       and branchId present on appointments/queue.
 */

// Dev mode → email uses jsonTransport (no SMTP) and OTP returns a devCode.
process.env.NODE_ENV = 'development';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const { io: ioClient } = require('socket.io-client');

const { Clinic, Patient, Appointment, QueueEntry, Reminder, AuditLog, OtpChallenge, Counter } = require('../src/models');
const { createApp } = require('../src/app');
const { initIo } = require('../src/realtime/io');
const branchService = require('../src/services/branchService');
const doctorService = require('../src/services/doctorService');
const appointmentService = require('../src/services/appointmentService');
const queueService = require('../src/services/queueService');
const reminderService = require('../src/services/reminderService');
const publicService = require('../src/services/publicService');
const patientService = require('../src/services/patientService');
const { emailAdapter } = require('../src/services/notifications');

const ctxAOwner = { clinicId: 'org_A', actorId: 'user_owner_a', actorRole: 'owner' };
const ctxARecep = { clinicId: 'org_A', actorId: 'user_recep_a', actorRole: 'receptionist' };
const ctxB = { clinicId: 'org_B', actorId: 'user_owner_b', actorRole: 'owner' };

const WIN = [{ start: '09:00', end: '18:00' }];
const AVAIL = { mon: WIN, tue: WIN, wed: WIN, thu: WIN, fri: WIN, sat: WIN, sun: WIN };

let mongod;
let server;
let base;
let branchA;
let doctorA;
let doctorB;

function waitFor(emitter, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    emitter.once(event, (...args) => {
      clearTimeout(t);
      resolve(args);
    });
  });
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Appointment.init(), QueueEntry.init(), Reminder.init(), Patient.init(), Clinic.init(), OtpChallenge.init()]);

  await Clinic.create({ clinicId: 'org_A', name: 'Demo Clinic', slug: 'demo-clinic', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_B', name: 'Other Clinic', slug: 'other-clinic', subscriptionPlan: 'basic' });

  branchA = await branchService.getOrCreatePrimaryBranch(ctxAOwner);
  await branchService.getOrCreatePrimaryBranch(ctxB);
  doctorA = await doctorService.createDoctor(ctxAOwner, 'standard', { name: 'Dr. Sen', specialization: 'Dentist', slotDurationMinutes: 30, availability: AVAIL });
  doctorB = await doctorService.createDoctor(ctxB, 'basic', { name: 'Dr. Roy', slotDurationMinutes: 30, availability: AVAIL });

  const app = createApp();
  server = http.createServer(app);
  initIo(server);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  // Clear operational data between tests; keep the seeded clinic/branch/doctor.
  await Promise.all([
    Appointment.deleteMany({}),
    QueueEntry.deleteMany({}),
    Reminder.deleteMany({}),
    AuditLog.deleteMany({}),
    OtpChallenge.deleteMany({}),
    Patient.deleteMany({}),
    Counter.deleteMany({}),
  ]);
  emailAdapter.clearSentLog();
});

// ---------------------------------------------------------------------------
test('(a) public booking via email OTP → appointment + token; 24h/2h reminders scheduled + emailed in dev', async () => {
  const email = 'rahul@example.com';

  const otp = await publicService.requestBookingOtp('demo-clinic', email);
  assert.ok(otp.devCode, 'dev returns the OTP code');
  assert.equal(emailAdapter.getSentLog().length, 1, 'OTP email was sent via the email adapter');

  await publicService.verifyBookingOtp('demo-clinic', email, otp.devCode);

  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600 * 1000); // +2 days (both reminders in the future)
  const booking = await publicService.publicBook('demo-clinic', {
    name: 'Rahul Sharma',
    phone: '9000000001',
    email,
    doctorId: doctorA._id,
    scheduledAt,
    reason: 'Toothache',
  });
  assert.ok(booking.token >= 1, 'a token number is issued');

  const appt = await Appointment.findById(booking.appointmentId).lean();
  assert.equal(appt.clinicId, 'org_A');
  assert.ok(appt.branchId, 'appointment carries branchId (hard rule 8)');
  assert.equal(appt.source, 'online');
  assert.equal(appt.status, 'booked');

  const reminders = await Reminder.find({ appointmentId: appt._id }).lean();
  assert.deepEqual(reminders.map((r) => r.type).sort(), ['appointment_24h', 'appointment_2h'].sort(), '24h + 2h reminders scheduled');

  // Email sends in dev: process due reminders as if "now" were the appointment time.
  emailAdapter.clearSentLog();
  const run1 = await reminderService.processDueReminders({ clinicId: 'org_A', now: scheduledAt });
  assert.equal(run1.sent, 2, 'both reminders sent');
  assert.equal(emailAdapter.getSentLog().length, 2, 'email adapter delivered 2 reminder emails');

  // Idempotent — never double-send (section 9.2).
  const run2 = await reminderService.processDueReminders({ clinicId: 'org_A', now: scheduledAt });
  assert.equal(run2.sent, 0, 'second run sends nothing (idempotent)');

  console.log('  ✓ (a) OTP booking → token + appointment; 24h/2h reminders scheduled, emailed once in dev (idempotent)');
});

// ---------------------------------------------------------------------------
test('(b) walk-in + today list + live queue updates over Socket.IO', async () => {
  const walk = await appointmentService.registerWalkIn(ctxARecep, {
    name: 'Wendy Walker',
    phone: '9000000002',
    doctorId: doctorA._id,
    scheduledAt: new Date(),
  });
  assert.equal(walk.appointment.source, 'walkin');
  assert.equal(walk.appointment.status, 'checked_in');
  assert.ok(walk.appointment.branchId && walk.appointment.tokenNumber >= 1);
  assert.equal(walk.queueEntry.status, 'waiting', 'walk-in lands in the queue');

  const today = await appointmentService.list(ctxARecep, {});
  assert.ok(today.some((a) => String(a._id) === String(walk.appointment._id)), "reception sees today's appointments");

  // Socket.IO: join the clinic/branch room, then call-next and expect a live update.
  const client = ioClient(base, { transports: ['websocket'], forceNew: true });
  await waitFor(client, 'connect');
  client.emit('queue:join', { clinicId: 'org_A', branchId: String(branchA._id) });
  await delay(80); // let the join take effect

  const updatePromise = waitFor(client, 'queue:update');
  await queueService.callNext(ctxARecep, { branchId: branchA._id });
  const [snapshot] = await updatePromise;

  assert.ok(snapshot.nowServing.length >= 1, 'TV receives a now-serving update');
  assert.equal(snapshot.nowServing[0].name, 'Wendy', 'display payload uses first name only (privacy)');
  assert.equal(snapshot.nowServing[0].token, walk.appointment.tokenNumber);
  client.close();

  console.log('  ✓ (b) walk-in registered + in today list; Socket.IO pushed a live queue update to the TV room');
});

// ---------------------------------------------------------------------------
test('(c) hard rules on new collections — tenant isolation, soft delete, audit log, branchId', async () => {
  // Patients + appointments in two clinics.
  const pA = await patientService.createPatient(ctxAOwner, { name: 'A Patient', phone: '111' });
  const pB = await patientService.createPatient(ctxB, { name: 'B Patient', phone: '222' });
  const apptA = await appointmentService.book(ctxAOwner, { doctorId: doctorA._id, patientId: pA._id, scheduledAt: new Date(Date.now() + 3600_000) });
  await appointmentService.book(ctxB, { doctorId: doctorB._id, patientId: pB._id, scheduledAt: new Date(Date.now() + 3600_000) });

  // Tenant isolation: B cannot see A's appointment.
  const seenByB = await appointmentService.list(ctxB, { from: new Date(0), to: new Date(Date.now() + 10 * 86400000) });
  assert.ok(!seenByB.some((a) => String(a._id) === String(apptA._id)), 'clinic B cannot list clinic A appointments');
  await assert.rejects(() => appointmentService.getById(ctxB, apptA._id), /not found/i, 'clinic B cannot fetch A appointment by id');

  // branchId present (hard rule 8).
  assert.ok(apptA.branchId, 'appointment has branchId');

  // Soft delete (owner): gone from default list, still in DB with deletedAt/deletedBy.
  await appointmentService.softDelete(ctxAOwner, apptA._id);
  const afterDelete = await appointmentService.list(ctxAOwner, { from: new Date(0), to: new Date(Date.now() + 10 * 86400000) });
  assert.ok(!afterDelete.some((a) => String(a._id) === String(apptA._id)), 'soft-deleted appointment excluded from default queries');
  const raw = await Appointment.findById(apptA._id).lean();
  assert.ok(raw && raw.deletedAt && raw.deletedBy === 'user_owner_a', 'record persists with deletedAt/deletedBy');

  // Audit log: appointment create + delete recorded, clinic-scoped.
  const logs = await AuditLog.find({ clinicId: 'org_A', entityType: 'Appointment', entityId: apptA._id }).lean();
  const actions = logs.map((l) => l.action);
  assert.ok(actions.includes('create') && actions.includes('delete'), 'audit log captured appointment create + delete');
  const bLogs = await AuditLog.find({ clinicId: 'org_B', entityType: 'Appointment', entityId: apptA._id }).lean();
  assert.equal(bLogs.length, 0, 'audit entries are clinic-scoped');

  console.log('  ✓ (c) appointments: tenant-isolated, soft-deletable, audited, branch-aware');
});

// ---------------------------------------------------------------------------
test('plan numeric limit — basic plan blocks a 2nd doctor (hard rule 5)', async () => {
  // Clinic B is on 'basic' (maxDoctors: 1) and already has one doctor from seeding.
  await assert.rejects(
    () => doctorService.createDoctor(ctxB, 'basic', { name: 'Dr. Extra' }),
    (err) => err.statusCode === 403 && err.error === 'upgrade_required',
    'second doctor on basic plan is rejected with upgrade_required'
  );
  console.log('  ✓ plan limit: basic plan caps doctors at 1 (backend-enforced)');
});

// ---- Audit-fix regression tests --------------------------------------------
test('[fix] plan limit cannot be bypassed by reactivating a deactivated doctor', async () => {
  // Use a fresh clinic so we don't disturb the seeded doctors.
  const ctx = { clinicId: 'org_C', actorId: 'owner_c', actorRole: 'owner' };
  await Clinic.create({ clinicId: 'org_C', name: 'Capped Clinic', slug: 'capped', subscriptionPlan: 'basic' });
  const d1 = await doctorService.createDoctor(ctx, 'basic', { name: 'Dr. One' }); // active #1 (cap reached)
  await doctorService.updateDoctor(ctx, d1._id, { isActive: false }, 'basic'); // free the seat
  const d2 = await doctorService.createDoctor(ctx, 'basic', { name: 'Dr. Two' }); // active #1 again — ok
  assert.ok(d2._id);
  // Reactivating d1 would make 2 active on a 1-doctor plan → must be blocked.
  await assert.rejects(
    () => doctorService.updateDoctor(ctx, d1._id, { isActive: true }, 'basic'),
    (err) => err.statusCode === 403 && err.error === 'upgrade_required',
    'reactivation past the cap is rejected'
  );
  console.log('  ✓ [fix] doctor cap re-checked on inactive→active (no isActive bypass)');
});

test('[fix] OTP request throttling blocks rapid re-requests (brute-force defense)', async () => {
  const email = 'throttle@example.com';
  await publicService.requestBookingOtp('demo-clinic', email); // first ok
  await assert.rejects(
    () => publicService.requestBookingOtp('demo-clinic', email),
    (err) => err.statusCode === 429,
    'second rapid request is throttled (429)'
  );
  console.log('  ✓ [fix] OTP requests are rate-limited per email (can’t reset the attempt budget)');
});

test('[fix] public booking matches patients by EXACT contact, never a substring', async () => {
  const victim = await patientService.createPatient(ctxAOwner, { name: 'Victim', phone: '9990001111', email: 'victim@ex.com' });

  const attackerEmail = 'attacker@ex.com';
  const otp = await publicService.requestBookingOtp('demo-clinic', attackerEmail);
  await publicService.verifyBookingOtp('demo-clinic', attackerEmail, otp.devCode);
  // phone '999' is a SUBSTRING of the victim's phone — must NOT attach to the victim.
  const booking = await publicService.publicBook('demo-clinic', {
    name: 'Mallory',
    phone: '999',
    email: attackerEmail,
    doctorId: doctorA._id,
    scheduledAt: new Date(Date.now() + 3 * 3600_000),
  });
  const appt = await Appointment.findById(booking.appointmentId).lean();
  assert.notEqual(String(appt.patientId), String(victim._id), 'booking must not be grafted onto the victim');
  const mallory = await Patient.findById(appt.patientId).lean();
  assert.equal(mallory.email, attackerEmail, 'a distinct patient was created for the verified email');

  console.log('  ✓ [fix] find-or-create uses exact verified contact (no cross-patient hijack)');
});

test('[fix] a reminder already sent is not re-opened/re-sent on reschedule (no double-send)', async () => {
  const p = await patientService.createPatient(ctxARecep, { name: 'Remind Me', phone: '700', email: 'remind@ex.com' });
  const scheduledAt = new Date(Date.now() + 2 * 24 * 3600 * 1000);
  const appt = await appointmentService.book(ctxARecep, { doctorId: doctorA._id, patientId: p._id, scheduledAt });

  emailAdapter.clearSentLog();
  const run1 = await reminderService.processDueReminders({ clinicId: 'org_A', now: scheduledAt });
  assert.equal(run1.sent, 2, 'both reminders sent the first time');

  // Reschedule AFTER the reminders already fired — must not re-open the sent docs.
  const later = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  await appointmentService.reschedule(ctxARecep, appt._id, later);
  emailAdapter.clearSentLog();
  const run2 = await reminderService.processDueReminders({ clinicId: 'org_A', now: later });
  assert.equal(run2.sent, 0, 'no reminder is re-sent after reschedule-of-already-sent');
  assert.equal(emailAdapter.getSentLog().length, 0, 'no duplicate emails');

  console.log('  ✓ [fix] sent reminders are never re-opened on reschedule (idempotent delivery)');
});
