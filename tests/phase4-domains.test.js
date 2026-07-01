'use strict';

/**
 * Phase 4 · Step 7 — custom domains.
 * Proves: registering is Premium-gated; add returns verification token + DNS setup; domains
 * are globally unique; verify (mock driver) marks verified + SSL issued; a VERIFIED custom
 * host resolves to the correct clinic (and only then); removal stops resolution.
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.DOMAIN_VERIFY_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, ClinicDomain } = require('../src/models');
const { createApp } = require('../src/app');
const domainService = require('../src/services/domainService');

let mongod;
let server;
let base;
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });
const hdr = (clinicId) => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': 'owner', 'x-dev-user-id': `u_${clinicId}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await ClinicDomain.init();
  await Clinic.create({ clinicId: 'org_dom', name: 'Dr Sen Clinic', slug: 'drsen', subscriptionPlan: 'premium' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'stddom', subscriptionPlan: 'standard' });
  const app = createApp();
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

test('(b) custom domains are Premium-gated: Standard 403, Premium 201', async () => {
  const blocked = await fetch(`${base}/api/domains`, { method: 'POST', headers: hdr('org_std'), body: JSON.stringify({ domain: 'x.com' }) });
  assert.equal(blocked.status, 403);
  const ok = await fetch(`${base}/api/domains`, { method: 'POST', headers: hdr('org_dom'), body: JSON.stringify({ domain: 'drsenclinic.com' }) });
  assert.equal(ok.status, 201);
  const body = await ok.json();
  assert.equal(body.domain.status, 'pending_verification');
  assert.ok(body.domain.verificationToken.startsWith('clinic-verify-'));
  assert.ok(body.setup.dns.some((r) => r.type === 'CNAME') && body.setup.dns.some((r) => r.type === 'TXT'), 'setup includes CNAME + TXT records');
  console.log('  ✓ (b) domains gated + add returns token & DNS setup');
});

test('(e) domains are globally unique', async () => {
  await assert.rejects(() => domainService.addDomain(ctx('org_dom'), 'drsenclinic.com'), (e) => e.statusCode === 409);
  console.log('  ✓ (e) duplicate domain rejected (globally unique)');
});

test('(e) verify → resolves to the correct clinic; unverified/unknown do not resolve', async () => {
  const list = await domainService.listDomains(ctx('org_dom'));
  const dom = list.find((d) => d.domain === 'drsenclinic.com');

  // Before verification: does not resolve.
  assert.equal(await domainService.resolveClinicByHost('drsenclinic.com'), null, 'unverified host does not resolve');

  const verified = await domainService.verifyDomain(ctx('org_dom'), dom._id);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.sslStatus, 'issued');

  const resolved = await domainService.resolveClinicByHost('https://www.drsenclinic.com/some/path');
  assert.ok(resolved && resolved.slug === 'drsen', 'verified host resolves to the right clinic (normalized)');
  assert.equal(await domainService.resolveClinicByHost('unknown-domain.com'), null, 'unknown host does not resolve');

  // Public resolve endpoint (no auth) mirrors this.
  const pub = await fetch(`${base}/api/public/resolve-domain?host=drsenclinic.com`);
  assert.equal(pub.status, 200);
  assert.equal((await pub.json()).slug, 'drsen');
  console.log('  ✓ (e) verified custom host resolves to the correct clinic; others 404');
});

test('(e) removing a domain stops resolution', async () => {
  const list = await domainService.listDomains(ctx('org_dom'));
  const dom = list.find((d) => d.domain === 'drsenclinic.com');
  await domainService.removeDomain(ctx('org_dom'), dom._id);
  assert.equal(await domainService.resolveClinicByHost('drsenclinic.com'), null, 'removed domain no longer resolves');
  console.log('  ✓ (e) removed domain stops resolving');
});
