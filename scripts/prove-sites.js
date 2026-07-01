'use strict';
const { connectDB, disconnectDB } = require('../src/config/db');
const ws = require('../src/services/websiteService');

(async () => {
  await connectDB();
  const slugs = ['clynic', 'sunrise-family', 'apex-ortho'];
  const sites = [];
  for (const s of slugs) {
    const { site } = await ws.getPublicSite(s);
    sites.push(site);
    console.log(`/c/${s}  template=${site.template}  primary=${site.theme.primaryColor}  headline="${site.content.hero.headline}"  doctors=[${site.doctors.map((d) => d.name).join(', ')}]  reviews=${site.reviews.length}`);
  }
  console.log('--- ZERO-BLEED CHECK (each site must contain ONLY its own doctors) ---');
  let bleed = false;
  for (let i = 0; i < sites.length; i++) {
    for (let j = 0; j < sites.length; j++) {
      if (i === j) continue;
      for (const d of sites[i].doctors) {
        if (JSON.stringify(sites[j]).includes(d.name)) { console.log(`BLEED: ${d.name} (${sites[i].clinic.name}) leaked into ${sites[j].clinic.name}`); bleed = true; }
      }
    }
  }
  console.log(bleed ? 'RESULT: DATA BLEED DETECTED' : 'RESULT: NO DATA BLEED — each site is fully isolated to its own clinic');
  await disconnectDB();
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });
