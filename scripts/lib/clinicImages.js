'use strict';

/**
 * Curated clinic photography for demo/seed content.
 *
 * Why this exists: the seeds used to point at `picsum.photos/seed/<x>`, which returns a RANDOM
 * photo per seed — piers, forests, sunsets. On a medical site that reads as broken. These are
 * on-subject clinical images (Pexels license: hotlinking + commercial use permitted, no
 * third-party clinic branding), and they mirror the pool the premium-signature template already
 * ships as its own fallback, so seeded sites and the template look like one product.
 *
 * Real clinics replace all of this from the CMS — this is only what a demo starts with.
 */
const px = (id, w = 1200) => `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=${w}`;

// Interiors, treatment rooms, equipment and care teams — all verified on-subject.
const IDS = {
  suite: 16571735, // luxury modern clinic suite, warm light
  interior: 16571732, // premium clinic interior
  lounge: 8459996, // bright waiting lounge
  consult: 7578797, // doctor–patient consultation, editorial
  imaging: 7800669, // clinicians reviewing a digital X-ray
  team: 6812569, // care team at work
  surgical: 7108114, // modern surgical room
  exam: 7108396, // exam room
  treatment: 7789601, // treatment room
  treatmentTeal: 7789620, // treatment room, teal
  equipment: 305567, // pristine treatment equipment
};

/** Wide hero shot. */
const hero = (key = 'suite') => px(IDS[key] || IDS.suite, 1600);

/** A gallery of `count` distinct clinic photos, offset so sibling clinics don't look identical. */
function gallery(count = 4, offset = 0) {
  const order = ['lounge', 'interior', 'treatment', 'team', 'exam', 'equipment', 'surgical', 'treatmentTeal'];
  return Array.from({ length: Math.min(count, order.length) }, (_, i) =>
    px(IDS[order[(i + offset) % order.length]], 1100)
  );
}

/** True for the placeholder hosts the old seeds used — the only URLs the fixer is allowed to touch. */
const PLACEHOLDER_HOSTS = /^https?:\/\/(picsum\.photos|via\.placeholder\.com|placehold\.co|loremflickr\.com|placekitten\.com)\//i;
const isPlaceholder = (url) => typeof url === 'string' && PLACEHOLDER_HOSTS.test(url.trim());

module.exports = { px, IDS, hero, gallery, isPlaceholder };
