'use strict';

/**
 * Dev seed — creates a demo clinic, primary branch, and a doctor so the app
 * (and the public booking page) has data to work with. Idempotent.
 *
 * Usage:
 *   node scripts/seed.js                       # clinicId 'org_dev_clinic_a', slug 'demo'
 *   SEED_CLINIC_ID=org_xxx SEED_SLUG=drsen node scripts/seed.js
 *
 * In DEV_AUTH mode, set the x-dev-clinic-id header to the same SEED_CLINIC_ID.
 * With real Clerk, set SEED_CLINIC_ID to your Clerk Organization id.
 */
const { connectDB, disconnectDB } = require('../src/config/db');
const { Clinic, Branch, Doctor } = require('../src/models');

const CLINIC_ID = process.env.SEED_CLINIC_ID || 'org_dev_clinic_a';
const SLUG = process.env.SEED_SLUG || 'demo';
const WIN = [{ start: '09:00', end: '13:00' }, { start: '15:00', end: '18:00' }];
const AVAIL = { mon: WIN, tue: WIN, wed: WIN, thu: WIN, fri: WIN, sat: [{ start: '10:00', end: '14:00' }] };

async function run() {
  await connectDB();

  const clinic = await Clinic.findOneAndUpdate(
    { clinicId: CLINIC_ID },
    {
      $set: {
        name: 'Demo Family Clinic',
        slug: SLUG,
        address: 'Salt Lake, Kolkata',
        phone: '+91 98300 00000',
        subscriptionPlan: 'standard',
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  let branch = await Branch.findOne({ clinicId: CLINIC_ID, isPrimary: true });
  if (!branch) {
    branch = await Branch.create({ clinicId: CLINIC_ID, name: 'Main branch', isPrimary: true, address: 'Salt Lake, Kolkata' });
  }

  const doctors = [
    { name: 'Dr. Anjali Sen', specialization: 'General Physician', consultationFee: 500 },
    { name: 'Dr. Rohan Roy', specialization: 'Dentist', consultationFee: 700 },
  ];
  for (const d of doctors) {
    await Doctor.findOneAndUpdate(
      { clinicId: CLINIC_ID, name: d.name },
      { $set: { ...d, clinicId: CLINIC_ID, availability: AVAIL, slotDurationMinutes: 30, isActive: true } },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  // eslint-disable-next-line no-console
  console.log(`Seeded clinic "${clinic.name}" (clinicId=${CLINIC_ID}, slug=${SLUG}) with 1 branch + ${doctors.length} doctors.`);
  console.log(`Public booking page: /c/${SLUG}`);
  await disconnectDB();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('seed failed', err);
  process.exit(1);
});
