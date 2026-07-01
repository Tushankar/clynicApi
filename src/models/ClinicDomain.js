'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable } = require('./plugins');

/**
 * clinicDomains — custom domains (e.g. drsenclinic.com) that map to a clinic (§5.19, step 7).
 *
 * The domain must be GLOBALLY unique (one clinic per domain), so incoming requests on a
 * custom host resolve to exactly one clinicId. Verification proves ownership (a DNS TXT
 * record containing verificationToken). SSL issuance is handled by the ingress/proxy infra
 * (ACME) — `sslStatus` mirrors that out-of-band state. Soft-deletable + audited (rules 6/7).
 */
const clinicDomainSchema = new mongoose.Schema(
  {
    domain: { type: String, required: true, trim: true, lowercase: true },
    status: { type: String, enum: ['pending_verification', 'verified'], default: 'pending_verification' },
    verificationToken: { type: String, required: true },
    verifiedAt: { type: Date, default: null },
    // Reflects the out-of-band SSL provisioning done by the ingress (ACME). Updated by infra.
    sslStatus: { type: String, enum: ['pending', 'issued', 'failed'], default: 'pending' },
  },
  { timestamps: true }
);

clinicScoped(clinicDomainSchema);
softDeletable(clinicDomainSchema);
// Globally unique domain (across clinics) — the resolution anchor. Partial so a soft-deleted
// domain can be re-registered later.
clinicDomainSchema.index({ domain: 1 }, { unique: true, partialFilterExpression: { deletedAt: null } });

module.exports = mongoose.model('ClinicDomain', clinicDomainSchema);
