'use strict';

const config = require('../../config/env');
const signing = require('../signing');

/**
 * Storage service — a single swappable interface over private-file storage (hard rule 3).
 * Select the backend with STORAGE_DRIVER (local | s3 | cloudinary); NONE ever yields a public
 * URL. Feature code depends only on this facade, so adding S3/Cloudinary later needs no
 * feature-code changes.
 *
 * Canonical interface:
 *   saveFile({ clinicId, key, buffer, contentType })   -> store private bytes
 *   getSignedUrl({ clinicId, key, ttlSeconds, meta })  -> short-lived, tokenized fetch URL (expires)
 *   deleteFile({ clinicId, key })                      -> remove
 *   createReadStream({ clinicId, key })                -> Readable (used by the signed byte route)
 *
 * (`put`/`remove` remain as aliases for existing callers.)
 */
function pickAdapter() {
  switch (config.storage.driver) {
    case 's3':
      return require('./s3Adapter');
    case 'cloudinary':
      return require('./cloudinaryAdapter');
    case 'local':
    default:
      return require('./localAdapter');
  }
}

const adapter = pickAdapter();

/**
 * Mint a SHORT-LIVED signed URL for a private object. For every driver this returns a link to
 * our own authenticated byte route (`/api/files/blob`) carrying an HMAC token that binds
 * clinicId + key + expiry — so possession of an unexpired token is the authorization, exactly
 * like an S3 presigned URL. (S3/Cloudinary may later return their native presigned URLs here
 * without touching callers.)
 */
function getSignedUrl({ clinicId, key, ttlSeconds = config.fileUrlTtlSeconds, meta = {} } = {}) {
  if (!clinicId || !key) throw new Error('storage.getSignedUrl requires clinicId and key');
  const token = signing.sign({ cid: clinicId, key, exp: Date.now() + ttlSeconds * 1000, ...meta });
  return {
    url: `${config.apiBaseUrl}/api/files/blob?t=${encodeURIComponent(token)}`,
    path: `/api/files/blob?t=${encodeURIComponent(token)}`,
    expiresInSeconds: ttlSeconds,
  };
}

/** Read a stored object fully into a Buffer (driver-agnostic; used to CID-inline email images). */
async function readBuffer({ clinicId, key }) {
  if (adapter.getBuffer) return adapter.getBuffer({ clinicId, key });
  const stream = adapter.createReadStream({ clinicId, key });
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

module.exports = {
  driver: adapter.driver,
  // canonical names
  saveFile: (args) => adapter.put(args),
  deleteFile: (args) => adapter.remove(args),
  createReadStream: (args) => adapter.createReadStream(args),
  readBuffer,
  getSignedUrl,
  // back-compat aliases (existing callers)
  put: (args) => adapter.put(args),
  remove: (args) => adapter.remove(args),
};
