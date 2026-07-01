'use strict';

/**
 * Local-dev storage service — the swappable interface (saveFile / getSignedUrl / deleteFile).
 * Proves: bytes are stored privately on local disk, a short-lived signed link is issued and
 * verifies, the bytes read back, an EXPIRED link is rejected, and delete removes the object.
 * No feature code / no Mongo needed — exercises the storage facade directly.
 */
process.env.NODE_ENV = 'test';
process.env.STORAGE_DRIVER = 'local';
process.env.LOCAL_STORAGE_DIR = './storage/test-run';
process.env.FILE_URL_SECRET = 'test-file-secret-please-rotate';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const storage = require('../src/lib/storage');
const signing = require('../src/lib/signing');

const CLINIC = 'org_store';
const KEY = 'reports/demo.txt';

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

after(() => {
  fs.rmSync(path.resolve(process.cwd(), './storage/test-run'), { recursive: true, force: true });
});

test('local storage: save → signed link → read back → delete', async () => {
  assert.equal(storage.driver, 'local');

  await storage.saveFile({ clinicId: CLINIC, key: KEY, buffer: Buffer.from('secret medical bytes'), contentType: 'text/plain' });

  // Signed link is short-lived + tokenized (mimics S3 presigned). It points at our own
  // authenticated byte route, never a public path.
  const link = storage.getSignedUrl({ clinicId: CLINIC, key: KEY, ttlSeconds: 60 });
  assert.match(link.path, /^\/api\/files\/blob\?t=/);
  const token = decodeURIComponent(link.path.split('t=')[1]);
  const payload = signing.verify(token);
  assert.ok(payload && payload.cid === CLINIC && payload.key === KEY, 'token binds clinic + key');

  const bytes = await readStream(await storage.createReadStream({ clinicId: CLINIC, key: KEY }));
  assert.equal(bytes.toString(), 'secret medical bytes');

  // An already-expired link does not verify (links expire, like S3).
  const expired = signing.sign({ cid: CLINIC, key: KEY, exp: Date.now() - 1000 });
  assert.equal(signing.verify(expired), null, 'expired signed link is rejected');

  await storage.deleteFile({ clinicId: CLINIC, key: KEY });
  await assert.rejects(async () => readStream(await storage.createReadStream({ clinicId: CLINIC, key: KEY })), 'deleted object is gone');
  console.log('  ✓ local storage service: private save, expiring signed link, read, delete');
});
