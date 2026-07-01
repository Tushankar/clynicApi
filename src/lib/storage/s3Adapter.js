'use strict';

const config = require('../../config/env');

/**
 * S3 private-bucket storage (production). Same interface as the local adapter.
 * The bucket MUST be private (no public ACL); we never store or return a public
 * URL — the app streams bytes through the signed file route (hard rule 3), or you
 * can later swap to S3 presigned GET URLs (still short-lived) behind this interface.
 *
 * @aws-sdk/client-s3 is lazy-required so a Redis/S3-less dev box never loads it.
 */
let client = null;
function s3() {
  if (client) return client;
  // eslint-disable-next-line global-require, import/no-unresolved
  const { S3Client } = require('@aws-sdk/client-s3');
  client = new S3Client({ region: config.storage.s3Region });
  return client;
}

async function put({ clinicId, key, buffer, contentType }) {
  // eslint-disable-next-line global-require, import/no-unresolved
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  await s3().send(
    new PutObjectCommand({ Bucket: config.storage.s3Bucket, Key: `${clinicId}/${key}`, Body: buffer, ContentType: contentType })
  );
}

async function createReadStream({ clinicId, key }) {
  // eslint-disable-next-line global-require, import/no-unresolved
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const res = await s3().send(new GetObjectCommand({ Bucket: config.storage.s3Bucket, Key: `${clinicId}/${key}` }));
  return res.Body; // a Node Readable stream
}

async function remove({ clinicId, key }) {
  // eslint-disable-next-line global-require, import/no-unresolved
  const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
  await s3().send(new DeleteObjectCommand({ Bucket: config.storage.s3Bucket, Key: `${clinicId}/${key}` }));
}

module.exports = { driver: 's3', put, createReadStream, remove };
