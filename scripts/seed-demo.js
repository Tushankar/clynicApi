'use strict';

/**
 * Demo data seeder — populates one clinic with realistic doctors, patients, appointments,
 * invoices, and a prescription/note so the Dashboard, CRM, and Analytics show something.
 *
 *   node scripts/seed-demo.js [clinicId]
 *
 * Targets the given clinicId, or the first clinic found. ADDITIVE — run once (re-running adds
 * more). Uses the app's DB config (Atlas + DNS fix). Not wired into the app; a dev convenience.
 */
const { connectDB, disconnectDB } = require('../src/config/env') && require('../src/config/db');
const { Clinic, Branch, Doctor, Patient, Appointment, Invoice, Prescription, ClinicalNote, QueueEntry } = require('../src/models');
const patientService = require('../src/services/patientService');

const DAY = 24 * 3600 * 1000;
const now = new Date();
const daysAgo = (n, h = 11) => { const d = new Date(now.getTime() - n * DAY); d.setHours(h, 0, 0, 0); return d; };
const daysFromNow = (n) => new Date(now.getTime() + n * DAY);
const birthdayIn = (n) => { const b = new Date(now.getTime() + n * DAY); return new Date(1990, b.getMonth(), b.getDate()); };
const pick = (arr, i) => arr[i % arr.length];

async function setCreatedAt(Model, id, date) {
  // Mongoose marks createdAt immutable when timestamps are on, so go through the raw driver.
  await Model.collection.updateOne({ _id: id }, { $set: { createdAt: date } });
}

async function run() {
  await connectDB();
  const clinicId = process.argv[2] || (await Clinic.findOne({}).lean())?.clinicId;
  if (!clinicId) throw new Error('No clinic found. Sign in to the app first to provision one.');
  const clinic = await Clinic.findOne({ clinicId });
  console.log('Seeding clinic:', clinicId, '(', clinic.name, ')');

  // --reset: wipe existing operational demo data for this clinic so a re-run is clean.
  if (process.argv.includes('--reset')) {
    const r = await Promise.all([
      Doctor.deleteMany({ clinicId }), Patient.deleteMany({ clinicId }), Appointment.deleteMany({ clinicId }),
      Invoice.deleteMany({ clinicId }), Prescription.deleteMany({ clinicId }), ClinicalNote.deleteMany({ clinicId }),
      QueueEntry.deleteMany({ clinicId }),
    ]);
    console.log('  reset: removed', r.reduce((s, x) => s + x.deletedCount, 0), 'existing docs');
  }

  // Tidy the auto-provisioned name/slug for a nicer demo (best-effort).
  try {
    clinic.name = 'Clynic';
    if (!(await Clinic.findOne({ slug: 'clynic', clinicId: { $ne: clinicId } }))) clinic.slug = 'clynic';
    clinic.subscriptionPlan = 'premium'; // so CRM/Analytics/AI are visible
    await clinic.save();
  } catch (e) { console.warn('  (name/slug tidy skipped:', e.message, ')'); }

  // ---- Branches (primary + a second so the branch switcher shows) ----
  let primary = await Branch.findOne({ clinicId, isPrimary: true });
  if (!primary) primary = await Branch.create({ clinicId, name: 'Main branch', isPrimary: true, address: 'Park Street, Kolkata', phone: '033-4000-1000' });
  let branch2 = await Branch.findOne({ clinicId, isPrimary: false });
  if (!branch2) branch2 = await Branch.create({ clinicId, name: 'Salt Lake branch', address: 'Sector V, Salt Lake, Kolkata', phone: '033-4000-2000' });

  const AVAIL = { mon: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }], tue: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }], wed: [{ start: '10:00', end: '14:00' }], thu: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }], fri: [{ start: '10:00', end: '14:00' }, { start: '16:00', end: '20:00' }], sat: [{ start: '10:00', end: '14:00' }], sun: [] };

  // ---- Doctors ----
  const docSpecs = [
    { name: 'Dr. Anjan Sen', specialization: 'Dentist', consultationFee: 500, slotDurationMinutes: 30 },
    { name: 'Dr. Priya Rao', specialization: 'ENT', consultationFee: 700, slotDurationMinutes: 20 },
    { name: 'Dr. Kavita Iyer', specialization: 'Pediatrician', consultationFee: 400, slotDurationMinutes: 15 },
  ];
  const doctors = [];
  for (const s of docSpecs) {
    doctors.push(await Doctor.create({ clinicId, availability: AVAIL, appointmentBufferMinutes: 0, isActive: true, ...s }));
  }
  console.log('  doctors:', doctors.length);

  // ---- Patients (varied so every CRM segment + analytics bucket is non-empty) ----
  const ctx = { clinicId, actorId: 'seed', actorRole: 'owner' };
  const pSpecs = [
    { name: 'Rahul Sharma', phone: '+91 98300 10001', email: 'rahul@example.com', gender: 'male', over: { createdDaysAgo: 210, lastVisitDaysAgo: 3, visitCount: 6, tags: ['repeat', 'high_value'] } },
    { name: 'Priya Das', phone: '+91 98300 10002', email: 'priya@example.com', gender: 'female', over: { createdDaysAgo: 95, lastVisitDaysAgo: 12, visitCount: 3, tags: ['repeat'] } },
    { name: 'Amit Roy', phone: '+91 98300 10003', gender: 'male', over: { createdDaysAgo: 300, lastVisitDaysAgo: 210, visitCount: 2, tags: ['repeat'] } },
    { name: 'Sunita Ghosh', phone: '+91 98300 10004', gender: 'female', over: { createdDaysAgo: 320, lastVisitDaysAgo: 250, visitCount: 1 } },
    { name: 'Neha Gupta', phone: '+91 98300 10005', email: 'neha@example.com', gender: 'female', dob: birthdayIn(5), over: { createdDaysAgo: 40, lastVisitDaysAgo: 20, visitCount: 1 } },
    { name: 'Vikram Singh', phone: '+91 98300 10006', gender: 'male', over: { createdDaysAgo: 60, lastVisitDaysAgo: 15, visitCount: 2, tags: ['repeat'], followUpInDays: 3 } },
    { name: 'Ananya Sen', phone: '+91 98300 10007', email: 'ananya@example.com', gender: 'female', over: { createdDaysAgo: 0, lastVisitDaysAgo: 0, visitCount: 1 } },
    { name: 'Karan Mehta', phone: '+91 98300 10008', gender: 'male', over: { createdDaysAgo: 0, visitCount: 0 } },
    { name: 'Deepa Nair', phone: '+91 98300 10009', email: 'deepa@example.com', gender: 'female', over: { createdDaysAgo: 150, lastVisitDaysAgo: 7, visitCount: 4, tags: ['repeat', 'high_value'] } },
    { name: 'Rohit Verma', phone: '+91 98300 10010', gender: 'male', over: { createdDaysAgo: 80, lastVisitDaysAgo: 40, visitCount: 1, followUpInDays: -2 } },
    { name: 'Meera Iyer', phone: '+91 98300 10011', gender: 'female', dob: birthdayIn(18), over: { createdDaysAgo: 20, lastVisitDaysAgo: 10, visitCount: 1 } },
    { name: 'Sanjay Kapoor', phone: '+91 98300 10012', email: 'sanjay@example.com', gender: 'male', bloodGroup: 'B+', allergies: ['Penicillin', 'Dust'], medicalHistory: 'Hypertension since 2019; appendectomy 2015.', over: { createdDaysAgo: 45, lastVisitDaysAgo: 30, visitCount: 2, tags: ['repeat'] } },
  ];
  const patients = [];
  for (const s of pSpecs) {
    const { over, ...create } = s;
    const p = await patientService.createPatient(ctx, create);
    const set = {};
    if (over.lastVisitDaysAgo != null) set.lastVisitAt = daysAgo(over.lastVisitDaysAgo);
    if (over.visitCount != null) set.visitCount = over.visitCount;
    if (over.tags) set.tags = over.tags;
    if (over.followUpInDays != null) set.followUpAt = daysFromNow(over.followUpInDays);
    if (Object.keys(set).length) await Patient.updateOne({ _id: p._id }, { $set: set });
    if (over.createdDaysAgo != null) await setCreatedAt(Patient, p._id, daysAgo(over.createdDaysAgo));
    patients.push({ ...p.toObject(), ...set });
  }
  console.log('  patients:', patients.length);

  // ---- Appointments (last 30 days for analytics; a few today for the dashboard) ----
  const apptHours = [9, 10, 11, 12, 15, 16, 17, 18];
  let token = 0;
  const mkAppt = async (patient, doctor, when, status, branch = primary) => {
    token += 1;
    return Appointment.create({
      clinicId, branchId: branch._id, patientId: patient._id, doctorId: doctor._id,
      patientName: patient.name, patientPhone: patient.phone, doctorName: doctor.name,
      scheduledAt: when, durationMinutes: doctor.slotDurationMinutes || 30, status,
      source: pick(['online', 'walkin', 'phone'], token), tokenNumber: token,
      reason: pick(['Check-up', 'Follow-up', 'Toothache', 'Fever', 'Consultation'], token),
    });
  };
  let apptCount = 0;
  // 16 completed across the last 28 days (Dr. Sen weighted → "most-visited"), varied hours.
  for (let i = 0; i < 16; i++) {
    const doctor = pick([doctors[0], doctors[0], doctors[1], doctors[2]], i); // Sen weighted
    const patient = pick(patients, i + 2);
    await mkAppt(patient, doctor, daysAgo(2 + (i % 27), pick(apptHours, i)), 'completed', pick([primary, primary, branch2], i));
    apptCount++;
  }
  // 3 no-shows + 2 cancellations (for the no-show rate).
  for (let i = 0; i < 3; i++) { await mkAppt(pick(patients, i), pick(doctors, i), daysAgo(3 + i * 4, 14), 'no_show'); apptCount++; }
  for (let i = 0; i < 2; i++) { await mkAppt(pick(patients, i + 5), pick(doctors, i), daysAgo(5 + i * 3, 15), 'cancelled'); apptCount++; }
  // Today: 2 completed, 1 checked-in, 1 upcoming (booked).
  await mkAppt(patients[0], doctors[0], (() => { const d = new Date(now); d.setHours(9, 30, 0, 0); return d; })(), 'completed'); apptCount++;
  await mkAppt(patients[1], doctors[1], (() => { const d = new Date(now); d.setHours(10, 30, 0, 0); return d; })(), 'completed'); apptCount++;
  await mkAppt(patients[6], doctors[2], (() => { const d = new Date(now); d.setHours(11, 30, 0, 0); return d; })(), 'checked_in'); apptCount++;
  await mkAppt(patients[7], doctors[0], (() => { const d = new Date(now); d.setHours(17, 0, 0, 0); return d; })(), 'booked'); apptCount++;
  console.log('  appointments:', apptCount);

  // ---- Live queue (today, primary branch): 1 now-serving + 4 waiting ----
  const queuePatients = [patients[2], patients[3], patients[4], patients[5], patients[10]];
  for (let i = 0; i < queuePatients.length; i++) {
    const p = queuePatients[i];
    const doctor = pick(doctors, i);
    // First patient is being seen (in_consultation); the rest are checked in and waiting.
    const apptStatus = i === 0 ? 'in_consultation' : 'checked_in';
    const queueStatus = i === 0 ? 'in_consultation' : 'waiting';
    const at = new Date(now); at.setHours(9 + i, 0, 0, 0);
    const appt = await Appointment.create({
      clinicId, branchId: primary._id, patientId: p._id, doctorId: doctor._id,
      patientName: p.name, patientPhone: p.phone, doctorName: doctor.name,
      scheduledAt: at, durationMinutes: 15, status: apptStatus, source: 'walkin', tokenNumber: i + 1, reason: 'Walk-in',
    });
    await QueueEntry.create({
      clinicId, branchId: primary._id, appointmentId: appt._id, patientId: p._id, doctorId: doctor._id,
      patientName: p.name, tokenNumber: i + 1, status: queueStatus,
      ...(queueStatus === 'in_consultation' ? { calledAt: new Date(), startedAt: new Date() } : {}),
      estimatedWaitMinutes: queueStatus === 'waiting' ? i * 15 : 0,
    });
  }
  console.log('  queue entries:', queuePatients.length, '(1 serving + 4 waiting)');

  // ---- Invoices (paid; revenue-by-day + high-value CRM). GST 18%. ----
  let inv = 0;
  const mkInvoice = async (patient, itemsList, createdDate, branch = primary) => {
    inv += 1;
    const subtotal = itemsList.reduce((s, it) => s + it.amount * (it.quantity || 1), 0);
    const gstAmount = Math.round(subtotal * 0.18 * 100) / 100;
    const total = subtotal + gstAmount;
    const doc = await Invoice.create({
      clinicId, branchId: branch._id, invoiceNumber: `INV-SEED-${String(inv).padStart(3, '0')}`,
      patientId: patient._id, patientName: patient.name, items: itemsList, subtotal, gstRate: 18, gstAmount, total,
      status: 'paid', amountPaid: total, payments: [{ amount: total, method: pick(['upi', 'card', 'cash'], inv), paidAt: createdDate }],
    });
    await setCreatedAt(Invoice, doc._id, createdDate);
  };
  // Spread over the last 9 days + a couple today.
  for (let i = 0; i < 10; i++) {
    await mkInvoice(pick(patients, i + 2), [{ description: 'Consultation', amount: pick([400, 500, 700], i) }, { description: 'Procedure', amount: pick([0, 300, 800, 1200], i) }].filter((x) => x.amount > 0), daysAgo(i, 12), pick([primary, branch2], i));
  }
  // High-value patients get big paid invoices.
  await mkInvoice(patients[0], [{ description: 'Root canal treatment', amount: 6000 }, { description: 'Crown', amount: 4000 }], daysAgo(3, 12)); // Rahul
  await mkInvoice(patients[8], [{ description: 'Sinus surgery consult + procedure', amount: 8500 }], daysAgo(6, 12)); // Deepa
  // Two dated today (today's revenue on the dashboard).
  await mkInvoice(patients[0], [{ description: 'Consultation', amount: 500 }], new Date());
  await mkInvoice(patients[1], [{ description: 'Consultation', amount: 700 }, { description: 'X-ray', amount: 600 }], new Date());
  console.log('  invoices:', inv);

  // ---- One prescription + clinical note (patient timeline) for Rahul ----
  await Prescription.create({ clinicId, branchId: primary._id, patientId: patients[0]._id, doctorId: doctors[0]._id, doctorName: doctors[0].name, diagnosis: 'Dental caries', items: [{ drug: 'Amoxicillin', dose: '500mg', frequency: 'TDS', duration: '5 days' }, { drug: 'Ibuprofen', dose: '400mg', frequency: 'BD', duration: '3 days' }], notes: 'Review after 1 week.' });
  await ClinicalNote.create({ clinicId, branchId: primary._id, patientId: patients[0]._id, doctorId: doctors[0]._id, doctorName: doctors[0].name, content: 'Patient reports tooth sensitivity. Advised RCT for tooth #26. Vitals normal.' });
  console.log('  prescriptions: 1  clinicalNotes: 1');

  console.log('Done. Refresh the app to see the data.');
  await disconnectDB();
}

run().then(() => process.exit(0)).catch((e) => { console.error('SEED FAILED:', e.name, e.message); if (e.errors) console.error(Object.keys(e.errors).map((k) => `${k}: ${e.errors[k].message}`).join(' | ')); process.exit(1); });
