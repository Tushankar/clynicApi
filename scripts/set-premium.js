'use strict';
const { connectDB, disconnectDB } = require('../src/config/db');
const { Clinic } = require('../src/models');

async function run() {
  await connectDB();
  const res = await Clinic.updateOne(
    { slug: 'clynic' },
    { $set: { 'website.template': 'premium-signature' } }
  );
  console.log('Update result:', res);
  await disconnectDB();
}
run();
