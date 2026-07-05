'use strict';

const { DosageSchedule } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');

/**
 * Dosage schedules read side (Ultra Premium, §6.5). Created by the dispense flow; listed for staff
 * (and later the patient portal). Flags each schedule active/finished from its endDate.
 */
function repo(ctx) {
  return tenantRepo(DosageSchedule, ctx);
}

async function listForPatient(ctx, patientId) {
  if (typeof patientId !== 'string' || !patientId) return { items: [] };
  const items = await repo(ctx).find({ patientId }, { sort: { createdAt: -1 }, limit: 200, lean: true });
  const now = Date.now();
  return { items: items.map((s) => ({ ...s, active: !s.endDate || new Date(s.endDate).getTime() >= now })) };
}

module.exports = { listForPatient };
