'use strict';

/**
 * Build MongoDB indexes for every model. Production connects with autoIndex OFF (src/config/db.js),
 * so a fresh production database has NO indexes — including the unique ones that tenant isolation
 * and race-safe provisioning rely on — until this runs. Safe to re-run on every deploy:
 * createIndexes() only creates what is missing and NEVER drops an index (unlike syncIndexes()).
 *
 * Usage:
 *   npm run db:indexes                 # uses MONGODB_URI from .env / the process env
 *
 * Exits non-zero if any model fails (e.g. a unique index blocked by existing duplicate rows).
 */
const { connectDB, disconnectDB } = require('../src/config/db');
const models = require('../src/models');

async function run() {
  await connectDB();

  let failed = 0;
  for (const [name, model] of Object.entries(models)) {
    if (typeof model?.createIndexes !== 'function') continue;
    try {
      await model.createIndexes();
      console.log(`[indexes] ${name}: ok`);
    } catch (err) {
      failed += 1;
      console.error(`[indexes] ${name}: FAILED — ${err.message}`);
    }
  }

  await disconnectDB();
  if (failed) {
    console.error(`[indexes] ${failed} model(s) failed`);
    process.exit(1);
  }
  console.log('[indexes] done');
}

run().catch(async (err) => {
  console.error('[indexes] error:', err.message);
  await disconnectDB().catch(() => {});
  process.exit(1);
});
