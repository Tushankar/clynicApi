'use strict';

const express = require('express');
const ctrl = require('../controllers/patientController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const { PHARMACY_STAFF } = require('../config/roles');

/**
 * Patient routes — the reference for RBAC wiring (hard rule 4).
 *
 * auth (attachAuthContext + requireAuth) is applied once at the router mount
 * point in routes/index.js, so every handler here already has req.ctx.
 *
 * Role policy (Phase 0):
 *   - read/list/create/update: owner, doctor, receptionist (all clinic staff)
 *   - soft delete:             owner only (destructive)
 *
 * Plan gating: basic patient records are available on every plan, so NO
 * requireFeature() here. Phase 2+ gated routes will add e.g.
 * requireFeature('PRESCRIPTIONS') after the role guard.
 */
const router = express.Router();

const ALL_STAFF = ['owner', 'doctor', 'receptionist'];
// Dispensing needs to find a patient and then read that one record. Pharmacy staff get exactly
// those two reads and nothing more — NOT /detail, NOT /timeline, and no writes. Without this the
// Ultra Premium dispense screen 403s on its mandatory first step for the two roles it was built for.
const LOOKUP_STAFF = [...ALL_STAFF, ...PHARMACY_STAFF];

router.get('/', requireRole(...LOOKUP_STAFF), ctrl.list);
router.get('/deleted', requireRole('owner'), ctrl.listDeleted); // owner "recently deleted" — before /:id
router.post('/', requireRole('owner', 'receptionist'), ctrl.create);
router.post('/:id/restore', requireRole('owner'), ctrl.restore); // undo a soft delete (owner-only)
router.get('/:id/detail', requireRole(...ALL_STAFF), ctrl.detail); // before /:id
// Patient timeline — Phase 2, plan-gated (PATIENT_TIMELINE).
router.get('/:id/timeline', requireRole(...ALL_STAFF), requireFeature('PATIENT_TIMELINE'), ctrl.timeline);
router.get('/:id', requireRole(...LOOKUP_STAFF), ctrl.get);
router.patch('/:id', requireRole('owner', 'doctor', 'receptionist'), ctrl.update);
router.delete('/:id', requireRole('owner'), ctrl.remove);

module.exports = router;
