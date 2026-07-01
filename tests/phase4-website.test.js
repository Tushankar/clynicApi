'use strict';

/**
 * Phase 4 · Step 6 — public website builder.
 * Proves: editing is Premium-gated + audited; the public site renders from clinic content
 * ONLY when published on a Premium plan (else falls back / unavailable); slug resolves to
 * the correct clinic (tenant-safe).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, AuditLog } = require('../src/models');
const { createApp } = require('../src/app');
const websiteService = require('../src/services/websiteService');

let mongod;
let server;
let base;
const ctx = (clinicId) => ({ clinicId, actorId: `u_${clinicId}`, actorRole: 'owner' });
const hdr = (clinicId) => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': 'owner', 'x-dev-user-id': `u_${clinicId}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Clinic.create({ clinicId: 'org_web', name: 'Web Clinic', slug: 'webc', subscriptionPlan: 'premium', address: '9 MG Road', phone: '033-999' });
  await Clinic.create({ clinicId: 'org_std', name: 'Std', slug: 'stdc', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_other', name: 'Other', slug: 'otherc', subscriptionPlan: 'premium' });
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

test('(b) website editing is Premium-gated: Standard 403, Premium 200', async () => {
  const blocked = await fetch(`${base}/api/website`, { method: 'PUT', headers: hdr('org_std'), body: JSON.stringify({ content: { headline: 'x' } }) });
  assert.equal(blocked.status, 403);
  const ok = await fetch(`${base}/api/website`, { method: 'PUT', headers: hdr('org_web'), body: JSON.stringify({ content: { headline: 'Best care', published: true } }) });
  assert.equal(ok.status, 200);
  console.log('  ✓ (b) website builder gated: Standard 403, Premium 200');
});

test('(e) content persists + is audited; sanitization bounds the blob', async () => {
  await websiteService.updateContent(ctx('org_web'), {
    published: true,
    headline: 'Compassionate care',
    services: [{ name: 'Cleaning', description: 'Scaling & polishing' }, { name: '', description: 'dropped (no name)' }],
    reviews: [{ author: 'A', rating: 9, text: 'Great' }], // rating clamps to 5
    contact: { phone: '033-999', mapUrl: 'https://maps.example/embed' },
    junkField: 'should not be stored',
  });
  const content = await websiteService.getContent(ctx('org_web'));
  assert.equal(content.headline, 'Compassionate care');
  assert.equal(content.services.length, 1, 'nameless service dropped');
  assert.equal(content.reviews[0].rating, 5, 'rating clamped to 5');
  assert.equal(content.junkField, undefined, 'unknown fields not stored');

  const logs = await AuditLog.find({ clinicId: 'org_web', entityType: 'Clinic', action: 'update' }).lean();
  assert.ok(logs.length >= 1, 'website content change is audited');
  console.log('  ✓ (e) content persisted, sanitized, and audited');
});

test('(e) public site renders when published on Premium; unavailable otherwise; slug-scoped', async () => {
  // Published Premium → available with content + doctors.
  const pub = await websiteService.getPublicSite('webc');
  assert.equal(pub.available, true);
  assert.equal(pub.clinic.name, 'Web Clinic');
  assert.equal(pub.content.headline, 'Compassionate care');

  // Standard clinic (even if it had content) → not available (plan lacks the feature).
  await websiteService.updateContent(ctx('org_std'), { published: true, headline: 'x' }).catch(() => {}); // service allows; route would 403
  const std = await websiteService.getPublicSite('stdc');
  assert.equal(std.available, false, 'Standard plan has no public site');

  // Premium but unpublished → not available.
  await websiteService.updateContent(ctx('org_other'), { published: false, headline: 'hidden' });
  const other = await websiteService.getPublicSite('otherc');
  assert.equal(other.available, false, 'unpublished site is not live');

  // Slug resolves to the correct clinic (tenant-safe).
  assert.notEqual(pub.clinic.slug, 'stdc');
  console.log('  ✓ (e) public site: published+Premium only, slug-scoped');
});
