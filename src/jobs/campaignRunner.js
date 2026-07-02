'use strict';

const campaignService = require('../services/campaignService');

/**
 * CRM campaign tick (§5.13). Every 10 minutes, run due birthday/follow-up automations —
 * cheap when nothing is due (one indexed clinics query), and per-patient idempotency in
 * campaignService means repeated ticks after a clinic's sendHour never double-send.
 */
let timer = null;

function start(intervalMs = 10 * 60 * 1000) {
  if (timer) return timer;
  timer = setInterval(() => {
    campaignService.runDueCampaigns().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[campaigns] tick error', err.message);
    });
  }, intervalMs);
  timer.unref?.();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { start, stop };
