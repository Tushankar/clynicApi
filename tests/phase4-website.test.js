'use strict';

/**
 * Public website + tiered CMS (§5.19 / 8.6).
 * Proves: TENANT ISOLATION on public routes (two slugs → two distinct sites, ZERO data bleed);
 * graceful auto-population for a bare Basic clinic; publish gating; slug resolution (path +
 * subdomain); and plan gating (WEBSITE_LIVE all plans, CMS_BASIC standard+, CMS_ADVANCED premium).
 */
process.env.NODE_ENV = 'development';
process.env.DEV_AUTH = 'true';
process.env.PAYMENTS_DRIVER = 'mock';
process.env.PLATFORM_DOMAIN = 'localhost';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

const { Clinic, Doctor } = require('../src/models');
const { createApp } = require('../src/app');
const websiteService = require('../src/services/websiteService');
const { slugFromRequest } = require('../src/lib/siteResolver');

let mongod;
let server;
let base;
const hdr = (clinicId, role = 'owner') => ({ 'content-type': 'application/json', 'x-dev-clinic-id': clinicId, 'x-dev-role': role, 'x-dev-user-id': `u_${clinicId}` });

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Promise.all([Clinic.init(), Doctor.init()]);
  // Two fully-distinct clinics for the isolation test.
  await Clinic.create({ clinicId: 'org_alpha', name: 'Alpha Dental', slug: 'alpha-dental', subscriptionPlan: 'premium', phone: '111', address: 'Alpha St', website: { published: true, template: 'modern-specialist', content: { hero: { headline: 'Alpha Dental — Perfect Smiles' }, about: 'Alpha about text.' }, reviews: [{ name: 'A1', text: 'Great alpha', rating: 5, approved: true }, { name: 'A2', text: 'hidden', rating: 4, approved: false }] } });
  await Clinic.create({ clinicId: 'org_beta', name: 'Beta Care', slug: 'beta-care', subscriptionPlan: 'basic', phone: '222', address: 'Beta Rd' }); // no website content → auto-populated
  await new Doctor({ clinicId: 'org_alpha', name: 'Dr Alpha', specialization: 'Dentist', isActive: true }).save();
  await new Doctor({ clinicId: 'org_beta', name: 'Dr Beta', specialization: 'Pediatrics', isActive: true }).save();
  // Plan-gating clinics.
  await Clinic.create({ clinicId: 'org_b2', name: 'Basic2', slug: 'basic2', subscriptionPlan: 'basic' });
  await Clinic.create({ clinicId: 'org_s2', name: 'Std2', slug: 'std2', subscriptionPlan: 'standard' });
  await Clinic.create({ clinicId: 'org_p2', name: 'Prem2', slug: 'prem2', subscriptionPlan: 'premium' });

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

test('(e) public site: two slugs render two distinct sites with ZERO data bleed', async () => {
  const a = await websiteService.getPublicSite('alpha-dental');
  const b = await websiteService.getPublicSite('beta-care');
  assert.equal(a.available, true);
  assert.equal(b.available, true);

  // Distinct identity + content.
  assert.equal(a.site.clinic.name, 'Alpha Dental');
  assert.equal(b.site.clinic.name, 'Beta Care');
  assert.match(a.site.content.hero.headline, /Alpha/);
  assert.equal(a.site.template, 'modern-specialist');

  // ZERO bleed: each site's doctors belong only to that clinic.
  assert.deepEqual(a.site.doctors.map((d) => d.name), ['Dr Alpha']);
  assert.deepEqual(b.site.doctors.map((d) => d.name), ['Dr Beta']);
  assert.ok(!JSON.stringify(a.site).includes('Dr Beta'), 'clinic B doctor never appears in clinic A site');
  assert.ok(!JSON.stringify(b.site).includes('Dr Alpha'), 'clinic A doctor never appears in clinic B site');

  // Reviews: only approved surface publicly.
  assert.deepEqual(a.site.reviews.map((r) => r.name), ['A1']);
  assert.ok(!JSON.stringify(a.site.reviews).includes('hidden'), 'unapproved review never public');
  console.log('  ✓ (e) two slugs → distinct sites, no data bleed, only approved reviews shown');
});

test('graceful auto-population: a bare Basic clinic still renders a complete site', async () => {
  const b = await websiteService.getPublicSite('beta-care');
  const c = b.site.content;
  assert.equal(c.hero.headline, 'Beta Care', 'hero defaults to clinic name');
  assert.ok(c.hero.tagline && c.about, 'tagline + about have sensible defaults');
  assert.ok(c.services.length >= 1 && c.services[0].name.includes('Pediatrics'), 'services derived from doctors');
  assert.ok(b.site.theme.primaryColor.startsWith('#'), 'theme has a default color');
  console.log('  ✓ bare Basic clinic auto-populates a full, non-empty site');
});

test('unpublished site is not served publicly', async () => {
  await Clinic.updateOne({ clinicId: 'org_alpha' }, { $set: { 'website.published': false } });
  const a = await websiteService.getPublicSite('alpha-dental');
  assert.equal(a.available, false);
  await Clinic.updateOne({ clinicId: 'org_alpha' }, { $set: { 'website.published': true } }); // restore
  console.log('  ✓ unpublished → not available');
});

test('slug resolution: ?slug= (path form) + <slug>.PLATFORM_DOMAIN (subdomain), reserved ignored', () => {
  assert.equal(slugFromRequest({ query: { slug: 'Alpha-Dental' }, headers: {} }), 'alpha-dental');
  assert.equal(slugFromRequest({ query: {}, headers: { host: 'beta-care.localhost:5000' } }), 'beta-care');
  assert.equal(slugFromRequest({ query: {}, headers: { host: 'www.localhost' } }), null);
  assert.equal(slugFromRequest({ query: {}, headers: { host: 'localhost' } }), null);
  console.log('  ✓ resolver: path slug + subdomain slug; reserved/base host ignored');
});

test('(b) plan gating: WEBSITE_LIVE all plans; CMS_BASIC standard+; CMS_ADVANCED premium only', async () => {
  // WEBSITE_LIVE (GET config, publish) — every plan.
  assert.equal((await fetch(`${base}/api/website`, { headers: hdr('org_b2') })).status, 200, 'Basic can read website config');

  // CMS_BASIC (content/theme) — Basic blocked, Standard allowed.
  const basicContent = await fetch(`${base}/api/website/content`, { method: 'PUT', headers: hdr('org_b2'), body: JSON.stringify({ content: { about: 'x' } }) });
  assert.equal(basicContent.status, 403, 'Basic blocked from editing content');
  assert.equal((await basicContent.json()).error, 'upgrade_required');
  assert.equal((await fetch(`${base}/api/website/content`, { method: 'PUT', headers: hdr('org_s2'), body: JSON.stringify({ content: { about: 'We care.' } }) })).status, 200, 'Standard can edit content');
  assert.equal((await fetch(`${base}/api/website/theme`, { method: 'PUT', headers: hdr('org_s2'), body: JSON.stringify({ template: 'warm-family' }) })).status, 200, 'Standard can edit theme');

  // CMS_ADVANCED (pages/reviews/seo) — Standard blocked, Premium allowed.
  assert.equal((await fetch(`${base}/api/website/pages`, { method: 'POST', headers: hdr('org_s2'), body: JSON.stringify({ title: 'FAQ', body: 'q' }) })).status, 403, 'Standard blocked from custom pages');
  assert.equal((await fetch(`${base}/api/website/seo`, { method: 'PUT', headers: hdr('org_s2'), body: JSON.stringify({ seo: { title: 't' } }) })).status, 403, 'Standard blocked from SEO');
  assert.equal((await fetch(`${base}/api/website/pages`, { method: 'POST', headers: hdr('org_p2'), body: JSON.stringify({ title: 'FAQ', body: 'answer' }) })).status, 201, 'Premium can add pages');
  assert.equal((await fetch(`${base}/api/website/reviews`, { method: 'PUT', headers: hdr('org_p2'), body: JSON.stringify({ reviews: [{ name: 'P', text: 'good', rating: 5, approved: true }] }) })).status, 200, 'Premium can manage reviews');

  // publish (WEBSITE_LIVE) — Basic allowed.
  assert.equal((await fetch(`${base}/api/website/publish`, { method: 'POST', headers: hdr('org_b2'), body: JSON.stringify({ published: true }) })).status, 200, 'Basic can publish');
  console.log('  ✓ (b) WEBSITE_LIVE=all, CMS_BASIC=standard+, CMS_ADVANCED=premium');
});

test('(security) a malicious logoUrl (javascript:/data:) is never returned to the public site', async () => {
  await Clinic.updateOne({ clinicId: 'org_alpha' }, { $set: { logoUrl: 'javascript:alert(1)', 'website.theme.logoUrl': 'data:text/html,evil' } });
  const a = await websiteService.getPublicSite('alpha-dental');
  assert.equal(a.site.theme.logoUrl, '', 'data:/javascript: logoUrl is stripped from the public site');
  await Clinic.updateOne({ clinicId: 'org_alpha' }, { $set: { logoUrl: 'https://cdn.example/logo.png', 'website.theme.logoUrl': '' } });
  const a2 = await websiteService.getPublicSite('alpha-dental');
  assert.equal(a2.site.theme.logoUrl, 'https://cdn.example/logo.png', 'a valid https logo is kept');
  console.log('  ✓ (security) logoUrl is http(s)-validated before public exposure');
});

test('(e) public HTTP route is slug-scoped (no bleed via ?slug=)', async () => {
  const a = await (await fetch(`${base}/api/public/site?slug=alpha-dental`)).json();
  const b = await (await fetch(`${base}/api/public/site?slug=beta-care`)).json();
  assert.equal(a.site.clinic.name, 'Alpha Dental');
  assert.equal(b.site.clinic.name, 'Beta Care');
  assert.notEqual(a.site.clinic.slug, b.site.clinic.slug);
  console.log('  ✓ (e) /public/site?slug= returns only the resolved clinic');
});
