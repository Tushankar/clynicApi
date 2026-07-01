'use strict';

const dns = require('dns');
const mongoose = require('mongoose');
const config = require('./env');

// Point Node's resolver at explicit DNS servers when configured (DNS_SERVERS). Fixes
// mongodb+srv:// on networks where Node's c-ares can't reach the system DNS (ECONNREFUSED)
// even though the OS resolves fine. No-op when DNS_SERVERS is unset.
if (config.dnsServers.length) {
  try {
    dns.setServers(config.dnsServers);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[db] could not apply DNS_SERVERS override:', err.message);
  }
}

/**
 * Mongoose connection management.
 *
 * Strict query/populate keep us honest: a typo'd field in a filter throws
 * instead of silently matching everything (which, on a tenant collection,
 * could leak across clinics — hard rule 1).
 */
mongoose.set('strictQuery', true);

let connectingPromise = null;

async function connectDB(uri = config.mongoUri) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  if (connectingPromise) return connectingPromise;

  connectingPromise = mongoose
    .connect(uri, {
      serverSelectionTimeoutMS: 10000,
      autoIndex: !config.isProd, // build indexes automatically in dev; do it explicitly in prod
    })
    .then((m) => {
      // eslint-disable-next-line no-console
      console.log(`[db] connected to MongoDB (${m.connection.name})`);
      return m.connection;
    })
    .catch((err) => {
      connectingPromise = null;
      throw err;
    });

  return connectingPromise;
}

async function disconnectDB() {
  connectingPromise = null;
  await mongoose.disconnect();
}

module.exports = { connectDB, disconnectDB, mongoose };
