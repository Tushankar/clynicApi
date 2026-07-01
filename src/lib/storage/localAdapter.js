'use strict';

const fs = require('fs');
const path = require('path');
const config = require('../../config/env');

/**
 * Local private-disk storage (dev default). Files live UNDER a private directory
 * (config.storage.localDir) that is NOT served statically by Express — there is
 * no public URL. Bytes are only reachable via the signed file route (hard rule 3).
 * Layout: <localDir>/<clinicId>/<key>
 */
const ROOT = path.resolve(process.cwd(), config.storage.localDir);

function fullPath(clinicId, key) {
  // key is server-generated (reportId/filename) — still guard against traversal.
  const safe = path.normalize(key).replace(/^(\.\.[/\\])+/, '');
  return path.join(ROOT, String(clinicId), safe);
}

async function put({ clinicId, key, buffer }) {
  const dest = fullPath(clinicId, key);
  await fs.promises.mkdir(path.dirname(dest), { recursive: true });
  await fs.promises.writeFile(dest, buffer);
}

function createReadStream({ clinicId, key }) {
  return fs.createReadStream(fullPath(clinicId, key));
}

async function remove({ clinicId, key }) {
  try {
    await fs.promises.unlink(fullPath(clinicId, key));
  } catch {
    /* already gone */
  }
}

module.exports = { driver: 'local', put, createReadStream, remove };
