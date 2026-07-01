'use strict';

const Counter = require('../models/Counter');

/**
 * Atomically allocate the next value of a named per-clinic sequence.
 *
 * Uses a single findOneAndUpdate($inc) with upsert, so two concurrent callers
 * can never receive the same number (unlike a count()+1 scheme). The first
 * value returned for a fresh sequence is 1.
 *
 * @param {string} clinicId
 * @param {string} name  e.g. 'patientCode'
 * @returns {Promise<number>}
 */
async function nextSequence(clinicId, name) {
  if (!clinicId) throw new Error('nextSequence requires a clinicId');
  const doc = await Counter.findOneAndUpdate(
    { clinicId, name },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return doc.seq;
}

module.exports = { nextSequence };
