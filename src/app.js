'use strict';

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { clerkMiddleware } = require('@clerk/express');

const config = require('./config/env');
const routes = require('./routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

/**
 * Express app factory. Kept separate from the server bootstrap (index.js) so
 * tests can build an app without opening a port.
 */
function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: config.corsOrigins.length ? config.corsOrigins : true,
      credentials: true,
    })
  );
  // Capture the raw body so payment webhook signatures can be verified over exact bytes.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: true }));
  if (!config.isProd) app.use(morgan('dev'));

  // Clerk: parses the session and makes getAuth(req) available downstream.
  // Skipped in DEV_AUTH mode (identity comes from x-dev-* headers instead).
  if (!config.devAuth) {
    app.use(
      clerkMiddleware({
        secretKey: config.clerk.secretKey,
        publishableKey: config.clerk.publishableKey,
      })
    );
  }

  app.use('/api', routes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
