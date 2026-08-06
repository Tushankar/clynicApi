'use strict';

/**
 * Replace placeholder website imagery with curated clinic photography.
 *
 *   node scripts/fix-site-images.js            # dry run — prints what WOULD change
 *   node scripts/fix-site-images.js --apply    # write the changes
 *
 * Deliberately surgical: unlike seed-sites.js (which overwrites a clinic's whole `website`
 * object) this ONLY swaps image URLs that point at a known placeholder host — picsum.photos and
 * friends, which serve a random photo per seed, so a dental site ends up showing a pier or a
 * sunset. Every other field the owner has edited — template, theme, copy, services, pages,
 * reviews, SEO — and any real image URL or uploaded image is left exactly as it is.
 *
 * Idempotent: a second run finds nothing to do.
 */
const { connectDB, disconnectDB } = require('../src/config/db');
const { Clinic } = require('../src/models');
const { hero, gallery, isPlaceholder } = require('./lib/clinicImages');

const APPLY = process.argv.includes('--apply');
const HERO_BY_INDEX = ['suite', 'consult', 'imaging', 'interior'];

async function run() {
  await connectDB();
  const clinics = await Clinic.find({}).select('clinicId name slug website logoUrl');
  let touched = 0;

  for (const [i, clinic] of clinics.entries()) {
    const content = clinic.website?.content;
    if (!content) continue;

    const changes = [];

    // Hero image
    if (isPlaceholder(content.hero?.imageUrl)) {
      const next = hero(HERO_BY_INDEX[i % HERO_BY_INDEX.length]);
      changes.push(`hero: ${short(content.hero.imageUrl)} → ${short(next)}`);
      if (APPLY) clinic.website.content.hero.imageUrl = next;
    }

    // Gallery — swap placeholders in place so any real photo the owner added keeps its position.
    const g = content.gallery || [];
    const placeholderCount = g.filter(isPlaceholder).length;
    if (placeholderCount) {
      const replacements = gallery(placeholderCount, i * 2);
      let n = 0;
      const next = g.map((url) => (isPlaceholder(url) ? replacements[n++] : url));
      changes.push(`gallery: ${placeholderCount} of ${g.length} placeholder image(s) replaced`);
      if (APPLY) clinic.website.content.gallery = next;
    }

    // Logos: a placeholder logo is worse than none — the templates fall back to the clinic name.
    if (isPlaceholder(clinic.website?.theme?.logoUrl)) {
      changes.push('theme.logoUrl: placeholder cleared (falls back to the clinic name)');
      if (APPLY) clinic.website.theme.logoUrl = '';
    }
    if (isPlaceholder(clinic.logoUrl)) {
      changes.push('clinic.logoUrl: placeholder cleared');
      if (APPLY) clinic.logoUrl = '';
    }

    if (!changes.length) continue;
    touched += 1;
    console.log(`\n${clinic.name} (/c/${clinic.slug})`);
    changes.forEach((c) => console.log(`   • ${c}`));
    if (APPLY) await clinic.save();
  }

  console.log(
    touched
      ? `\n${APPLY ? 'Updated' : 'Would update'} ${touched} clinic site(s).${APPLY ? '' : '  Re-run with --apply to write.'}`
      : '\nNothing to do — no placeholder imagery found.'
  );
  await disconnectDB();
}

const short = (u) => String(u).replace(/^https?:\/\//, '').slice(0, 48);

run()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FIX SITE IMAGES FAILED:', e.name, e.message);
    process.exit(1);
  });
