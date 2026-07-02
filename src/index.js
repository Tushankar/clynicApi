'use strict';

const http = require('http');
const config = require('./config/env');
const { connectDB, disconnectDB } = require('./config/db');
const { createApp } = require('./app');
const { initIo } = require('./realtime/io');
const reminderQueue = require('./jobs/reminderQueue');
const campaignRunner = require('./jobs/campaignRunner');
require('./models'); // register all models once

async function start() {
  await connectDB();
  const app = createApp();
  const server = http.createServer(app);

  // Socket.IO for the live queue / TV display.
  initIo(server);

  // Reminders: BullMQ worker when Redis is configured + reachable; otherwise a fallback poller.
  const jobs = await reminderQueue.init();
  if (!jobs.enabled) reminderQueue.startFallbackPoller();

  // CRM campaign automations (birthday / follow-up) — 10-minute tick, idempotent per day.
  campaignRunner.start();

  server.listen(config.port, () => {
    // eslint-disable-next-line no-console
    console.log(`[clinic-api] listening on :${config.port} (${config.nodeEnv}) · reminders=${jobs.mode} · ai=${config.ai.driver}/${config.ai.model}`);
    if (config.devAuth) {
      // eslint-disable-next-line no-console
      console.warn('[clinic-api] DEV_AUTH is ON — identity from x-dev-* headers. Never use in production.');
    }
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[clinic-api] ${signal} received, shutting down`);
    const forceExit = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error('[clinic-api] forced shutdown after timeout');
      process.exit(1);
    }, 10000);
    forceExit.unref();
    server.close(async () => {
      try {
        campaignRunner.stop();
        await reminderQueue.close();
        await disconnectDB();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('[clinic-api] error during shutdown', err);
      } finally {
        clearTimeout(forceExit);
        process.exit(0);
      }
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[clinic-api] failed to start', err);
  process.exit(1);
});
