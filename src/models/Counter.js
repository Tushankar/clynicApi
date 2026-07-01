'use strict';

const mongoose = require('mongoose');

/**
 * counters — atomic, per-clinic monotonic sequences (patient codes now; invoice
 * numbers, token numbers, etc. later). Incremented via a single atomic
 * findOneAndUpdate($inc), so concurrent requests each get a distinct value with
 * no races and no collisions. Internal infrastructure: not clinical/financial
 * data, so it is intentionally NOT routed through the tenant repo / audit log.
 */
const counterSchema = new mongoose.Schema(
  {
    clinicId: { type: String, required: true },
    name: { type: String, required: true }, // e.g. 'patientCode'
    seq: { type: Number, default: 0 },
  },
  { timestamps: true }
);

counterSchema.index({ clinicId: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('Counter', counterSchema);
