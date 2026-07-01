'use strict';

const config = require('../config/env');
const reminderService = require('../services/reminderService');

/**
 * Reminder transport (section 9.2). With REDIS_URL set, uses BullMQ delayed jobs
 * (jobId per reminder → enqueue is idempotent; the worker delivers at sendAt).
 * Without Redis, falls back to a periodic poller that runs processDueReminders.
 * Either way the `reminders` collection is the source of truth and delivery is
 * claimed-before-send, so reminders never double-fire.
 */
let queue = null;
let worker = null;
let connection = null;
let poller = null;

function init() {
  if (!config.redisUrl) return { enabled: false, mode: 'poller' };

  // Lazy-require so a Redis-less environment never loads the client.
  const { Queue, Worker } = require('bullmq');
  const IORedis = require('ioredis');
  connection = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  queue = new Queue('reminders', { connection });
  worker = new Worker(
    'reminders',
    async (job) => reminderService.processOneReminder(job.data.reminderId),
    { connection }
  );

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

/** Fallback when there is no Redis: poll for due reminders every minute. */
function startFallbackPoller(intervalMs = 60_000) {
  if (poller || config.redisUrl) return null;
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
  if (worker) await worker.close();
  if (queue) await queue.close();
  if (connection) await connection.quit();
}

module.exports = { init, startFallbackPoller, close };
