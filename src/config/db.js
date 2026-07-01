'use strict';

const mongoose = require('mongoose');
const config = require('./env');

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
