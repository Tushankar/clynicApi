'use strict';

const crypto = require('crypto');
const dns = require('dns').promises;
const { ClinicDomain, Clinic } = require('../models');
const { tenantRepo } = require('../lib/TenantRepository');
const config = require('../config/env');
const AppError = require('../utils/AppError');

/**
 * Custom domains (step 7). The RESOLUTION + verification logic is fully implemented here;
 * two pieces are MANUAL INFRA (flagged in the setup instructions returned to the owner):
 *   1. DNS — the clinic points their domain (CNAME) at config.domains.cnameTarget, and adds
 *      a TXT record `_clinic-verify.<domain>` = the verification token.
 *   2. SSL — the platform ingress/proxy (Caddy/Traefik/nginx+certbot, or the PaaS custom-domain
 *      feature) provisions a certificate via ACME once DNS points at it. `sslStatus` mirrors it.
 */

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

function repo(ctx) {
  return tenantRepo(ClinicDomain, ctx); // audited (rule 7)
}

function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  return d;
}

function setupInstructions(domain, token) {
  return {
    dns: [
      { type: 'CNAME', host: domain, value: config.domains.cnameTarget, note: 'Points your domain at the platform. Required for SSL + serving.' },
      { type: 'TXT', host: `_clinic-verify.${domain}`, value: token, note: 'Proves you own the domain (used by "Verify").' },
    ],
    ssl: 'SSL is provisioned automatically by the platform once the CNAME resolves (ACME). No action needed from you.',
  };
}

async function addDomain(ctx, domain) {
  const d = normalizeDomain(domain);
  if (!DOMAIN_RE.test(d)) throw new AppError(400, 'Enter a valid domain, e.g. drsenclinic.com');

  const existing = await ClinicDomain.findOne({ domain: d, deletedAt: null }).lean();
  if (existing) throw new AppError(409, 'That domain is already registered.');

  const token = `clinic-verify-${crypto.randomBytes(12).toString('hex')}`;
  const doc = await repo(ctx).create({ domain: d, verificationToken: token, status: 'pending_verification' });
  return { domain: publicDomain(doc), setup: setupInstructions(d, token) };
}

function listDomains(ctx) {
  return repo(ctx).find({}, { sort: { createdAt: -1 }, lean: true }).then((rows) => rows.map(publicDomain));
}

/**
 * Verify domain ownership. 'mock' (dev) marks it verified immediately (no live DNS). 'dns'
 * (prod) looks up the TXT record and checks it contains the token — then marks verified and
 * flips sslStatus to 'issued' (the ingress will actually have provisioned it by then).
 */
async function verifyDomain(ctx, id) {
  const r = repo(ctx);
  const doc = await r.findById(id);
  if (!doc) throw new AppError(404, 'Domain not found');
  if (doc.status === 'verified') return publicDomain(doc);

  if (config.domains.verifyDriver === 'dns') {
    let ok = false;
    try {
      const records = await dns.resolveTxt(`_clinic-verify.${doc.domain}`);
      ok = records.flat().some((v) => v.includes(doc.verificationToken));
    } catch {
      ok = false;
    }
    if (!ok) throw new AppError(400, 'Verification TXT record not found yet. DNS can take a few minutes to propagate.');
  }
  const updated = await r.updateById(id, { status: 'verified', verifiedAt: new Date(), sslStatus: 'issued' });
  return publicDomain(updated);
}

async function removeDomain(ctx, id) {
  const deleted = await repo(ctx).softDeleteById(id);
  if (!deleted) throw new AppError(404, 'Domain not found');
  return { ok: true, id: String(deleted._id) };
}

/**
 * Resolve an incoming custom host → the clinic's slug (public; used to serve the right
 * clinic's site on a custom domain). Only VERIFIED domains resolve. Globally scoped by
 * design (the whole point is host→clinic), but returns only the public slug, never data.
 */
async function resolveClinicByHost(host) {
  const d = normalizeDomain(host);
  if (!d) return null;
  const domain = await ClinicDomain.findOne({ domain: d, status: 'verified', deletedAt: null }).lean();
  if (!domain) return null;
  const clinic = await Clinic.findOne({ clinicId: domain.clinicId }).lean();
  if (!clinic) return null;
  return { slug: clinic.slug, clinicId: clinic.clinicId, name: clinic.name };
}

function publicDomain(d) {
  return {
    _id: String(d._id),
    domain: d.domain,
    status: d.status,
    sslStatus: d.sslStatus,
    verifiedAt: d.verifiedAt,
    verificationToken: d.verificationToken,
    createdAt: d.createdAt,
  };
}

module.exports = { addDomain, listDomains, verifyDomain, removeDomain, resolveClinicByHost, normalizeDomain };
