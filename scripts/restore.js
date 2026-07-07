'use strict';

/**
 * Restore a MongoDB backup produced by scripts/backup.js (the audit's "no restore tooling" gap).
 *
 *   node scripts/restore.js <archive.gz> --yes
 *
 * DESTRUCTIVE: restores WITH --drop (replaces existing collections), so it requires an explicit
 * `--yes` (or CONFIRM_RESTORE=yes) to run — never let a stray cron wipe live data.
 *
 * Env: MONGODB_URI (target db). Requires `mongorestore` on PATH (MongoDB Database Tools).
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/clinic-os';
const args = process.argv.slice(2);
const archive = args.find((a) => !a.startsWith('--'));
const confirmed = args.includes('--yes') || process.env.CONFIRM_RESTORE === 'yes';

if (!archive) {
  console.error('Usage: node scripts/restore.js <path-to-archive.gz> --yes');
  process.exit(2);
}
if (!fs.existsSync(archive)) {
  console.error(`[restore] archive not found: ${archive}`);
  process.exit(2);
}
if (!confirmed) {
  console.error(`[restore] REFUSING to run without confirmation. This DROPS and replaces the target database:\n  ${URI.replace(/\/\/[^@]*@/, '//***@')}\nRe-run with --yes (or CONFIRM_RESTORE=yes) once you are sure.`);
  process.exit(1);
}

console.log(`[restore] restoring ${archive} → ${URI.replace(/\/\/[^@]*@/, '//***@')} (with --drop)`);
const res = spawnSync('mongorestore', [`--uri=${URI}`, `--archive=${archive}`, '--gzip', '--drop'], { stdio: 'inherit' });

if (res.error && res.error.code === 'ENOENT') {
  console.error('[restore] `mongorestore` not found on PATH. Install the MongoDB Database Tools: https://www.mongodb.com/docs/database-tools/installation/');
  process.exit(127);
}
if (res.status !== 0) {
  console.error(`[restore] mongorestore failed (exit ${res.status}).`);
  process.exit(res.status || 1);
}
console.log('[restore] OK.');
