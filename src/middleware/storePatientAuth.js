'use strict';

const patientSession = require('../lib/patientSession');
const { Clinic } = require('../models');
const { planHasFeature } = require('../config/plans');
const AppError = require('../utils/AppError');

/**
 * Storefront patient auth (Ultra Premium, UP-D). Mirrors patientAuth but gates on PHARMACY_STOREFRONT
 * (NOT PATIENT_PORTAL), so ONLY Ultra clinics expose the online store — the live patient portal's
 * PATIENT_PORTAL gate is left completely untouched. Verifies the (shared) patient session token and
 * attaches req.patient + req.ctx (tenant-scoped). A non-Ultra clinic 404s here — the store doesn't exist for them.
 */
async function storePatientAuth(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : req.query.t || null;
    const data = patientSession.verify(token);
    if (!data || !data.clinicId || !data.patientId) throw new AppError(401, 'Patient session required');

    const clinic = await Clinic.findOne({ clinicId: data.clinicId }).lean();
    if (!clinic) throw new AppError(401, 'Clinic not found');
    // Hide (404), not 403: the storefront simply does not exist for non-Ultra clinics.
    if (!planHasFeature(clinic.subscriptionPlan, 'PHARMACY_STOREFRONT')) throw new AppError(404, 'Not available');

    req.patient = { clinicId: data.clinicId, patientId: data.patientId, email: data.email };
    req.ctx = { clinicId: data.clinicId, actorId: `patient:${data.patientId}`, actorRole: null };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { storePatientAuth };
