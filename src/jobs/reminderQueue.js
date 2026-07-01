'use strict';

const config = require('../config/env');
const reminderService = require('../services/reminderService');

/**
 * Reminder transport (section 9.2). With REDIS_URL set AND reachable, uses BullMQ delayed jobs
 * (jobId per reminder → enqueue is idempotent; the worker delivers at sendAt). Otherwise —
 * no REDIS_URL, or a set-but-unreachable one — falls back to a periodic poller that runs
 * processDueReminders. Either way the `reminders` collection is the source of truth and
 * delivery is claimed-before-send, so reminders never double-fire.
 */
let queue = null;
let worker = null;
let connection = null;
let poller = null;

/**
 * Set up the reminder transport. Async because it PRE-FLIGHTS Redis: if REDIS_URL is set but
 * unreachable, we degrade to the poller BEFORE constructing BullMQ — so a set-but-down Redis
 * never silently drops reminders (and BullMQ's internal blocking connection never crashes the
 * process on an unhandled connect error). Returns { enabled, mode }.
 */
async function init() {
  if (!config.redisUrl) return { enabled: false, mode: 'poller' };

  // Lazy-require so a Redis-less environment never loads the client.
  const IORedis = require('ioredis');

  // Pre-flight probe: is Redis actually reachable? Its own error handler + no-retry keep this
  // from throwing or hanging; connectTimeout bounds it.
  const probe = new IORedis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, retryStrategy: () => null, connectTimeout: 4000 });
  probe.on('error', () => {}); // prevent an unhandled 'error' event on failure
  try {
    await probe.connect();
    await probe.ping();
  } catch (err) {
    try { probe.disconnect(); } catch { /* ignore */ }
    // eslint-disable-next-line no-console
    console.warn(`[reminders] Redis unavailable (${err.code || err.message}) — falling back to the DB poller so reminders still fire.`);
    return { enabled: false, mode: 'poller' }; // caller starts the poller
  }
  try { probe.disconnect(); } catch { /* ignore */ }

  // Redis is confirmed reachable → construct BullMQ.
  const { Queue, Worker } = require('bullmq');
  connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  connection.on('error', () => {}); // stay resilient to later transient blips (don't crash)

  queue = new Queue('reminders', { connection });
  queue.on('error', () => {});
  worker = new Worker(
    'reminders',
    async (job) => reminderService.processOneReminder(job.data.reminderId),
    { connection }
  );
  worker.on('error', () => {});

  reminderService.setEnqueuer(async (reminder) => {
    const delay = Math.max(0, new Date(reminder.sendAt).getTime() - Date.now());
    const jobId = `rem:${reminder._id}`;
    // Drop any prior delayed job first — BullMQ ignores add() for an existing jobId,
    // so without this a reschedule would keep firing at the OLD time. (No-op if active.)
    await queue.remove(jobId).catch(() => {});
    await queue.add('send', { reminderId: String(reminder._id) }, { delay, jobId, removeOnComplete: true, removeOnFail: 1000 });
  });

  return { enabled: true, mode: 'bullmq' };
}

/** Poll for due reminders every minute (no-Redis mode, or when Redis is unreachable). */
function startFallbackPoller(intervalMs = 60_000) {
  if (poller) return null;
  poller = setInterval(() => {
    reminderService.processDueReminders().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[reminders] poller error', err.message);
    });
  }, intervalMs);
  poller.unref?.();
  return poller;
}

async function close() {
  if (poller) clearInterval(poller);
  if (worker) await worker.close().catch(() => {});
  if (queue) await queue.close().catch(() => {});
  if (connection) await connection.quit().catch(() => {});
}

module.exports = { init, startFallbackPoller, close };
