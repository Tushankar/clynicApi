'use strict';

/**
 * Automated MongoDB backup (the audit's #1 gap: "no automated database backup").
 *
 * Dumps the whole database to a single timestamped, gzipped archive via `mongodump`, then prunes
 * old archives beyond a retention count. Designed to be run from cron / a scheduled task:
 *
 *   node scripts/backup.js
 *
 * Env (read from clynicApi/.env or the process env):
 *   MONGODB_URI        connection string (required; falls back to the app default)
 *   BACKUP_DIR         output directory (default ./backups)
 *   BACKUP_RETENTION   how many archives to keep (default 14)
 *
 * Requires the MongoDB Database Tools (`mongodump`) on PATH:
 *   https://www.mongodb.com/docs/database-tools/installation/  (the API Docker image can add them,
 *   or run this from a small sidecar that has them). Restore with scripts/restore.js.
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/clinic-os';
const OUT_DIR = path.resolve(process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups'));
const RETENTION = Math.max(1, Number(process.env.BACKUP_RETENTION || 14));

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const archive = path.join(OUT_DIR, `clinic-${stamp()}.archive.gz`);

  console.log(`[backup] dumping ${URI.replace(/\/\/[^@]*@/, '//***@')} → ${archive}`);
  const res = spawnSync('mongodump', [`--uri=${URI}`, `--archive=${archive}`, '--gzip'], { stdio: 'inherit' });

  if (res.error && res.error.code === 'ENOENT') {
    console.error('[backup] `mongodump` not found on PATH. Install the MongoDB Database Tools: https://www.mongodb.com/docs/database-tools/installation/');
    process.exit(127);
  }
  if (res.status !== 0) {
    console.error(`[backup] mongodump failed (exit ${res.status}).`);
    process.exit(res.status || 1);
  }
  const { size } = fs.statSync(archive);
  console.log(`[backup] OK — ${(size / 1024 / 1024).toFixed(1)} MB`);

  // Retention: keep the newest RETENTION archives, delete the rest.
  const archives = fs
    .readdirSync(OUT_DIR)
    .filter((f) => /^clinic-\d{8}-\d{6}\.archive\.gz$/.test(f))
    .sort() // lexical sort == chronological for this name format
    .reverse();
  const stale = archives.slice(RETENTION);
  for (const f of stale) {
    fs.unlinkSync(path.join(OUT_DIR, f));
    console.log(`[backup] pruned old archive ${f}`);
  }
  console.log(`[backup] done — ${Math.min(archives.length, RETENTION)} archive(s) retained in ${OUT_DIR}`);
}

main();
