'use strict';

const mongoose = require('mongoose');
const { clinicScoped } = require('./plugins');
const { ALL_ROLES } = require('../config/roles');

/**
 * staff — clinic-specific profile data keyed to a Clerk user.
 * Identity (login, password, MFA) lives in Clerk; this stores the clinic-scoped
 * profile + the authoritative role mirror. The live role used for RBAC comes
 * from the Clerk org role on each request; this copy supports listings/audit.
 */
const staffSchema = new mongoose.Schema(
  {
    clerkUserId: { type: String, required: true }, // Clerk user id
    role: { type: String, enum: ALL_ROLES, required: true },
    name: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    phone: { type: String, trim: true },
  },
  { timestamps: true }
);

clinicScoped(staffSchema);

// A Clerk user appears at most once per clinic.
staffSchema.index({ clinicId: 1, clerkUserId: 1 }, { unique: true });

module.exports = mongoose.model('Staff', staffSchema);
