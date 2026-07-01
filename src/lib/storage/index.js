'use strict';

const config = require('../../config/env');

/**
 * Storage facade — selects the configured private-storage adapter. Both adapters
 * expose the same interface: put / createReadStream / remove. Neither ever yields
 * a public URL (hard rule 3).
 */
const adapter = config.storage.driver === 's3' ? require('./s3Adapter') : require('./localAdapter');

module.exports = adapter;
