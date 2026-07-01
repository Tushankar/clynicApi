'use strict';

const patientSession = require('../lib/patientSession');
const { Clinic } = require('../models');
const { planHasFeature } = require('../config/plans');
const AppError = require('../utils/AppError');

/**
 * Patient-portal auth: verifies the patient session token and attaches req.patient +
 * req.ctx (so tenant-scoped services work). Also enforces the clinic's PATIENT_PORTAL
 * plan gate (hard rule 5) and that the portal is reachable only by the token's own
 * clinic + patient (tenant isolation, hard rule 1).
 */
async function patientAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.t || null;
    const data = patientSession.verify(token);
    if (!data || !data.clinicId || !data.patientId) throw new AppError(401, 'Patient session required');

    const clinic = await Clinic.findOne({ clinicId: data.clinicId }).lean();
    if (!clinic) throw new AppError(401, 'Clinic not found');
    if (!planHasFeature(clinic.subscriptionPlan, 'PATIENT_PORTAL')) {
      return next(new AppError(403, 'Patient portal is not available on this clinic’s plan', { error: 'upgrade_required', feature: 'PATIENT_PORTAL' }));
    }

    req.patient = { clinicId: data.clinicId, patientId: data.patientId, email: data.email };
    // Scope every service call to this clinic; actor identifies the patient for audit.
    req.ctx = { clinicId: data.clinicId, actorId: `patient:${data.patientId}`, actorRole: null };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { patientAuth };
