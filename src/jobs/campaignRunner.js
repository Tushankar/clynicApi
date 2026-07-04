'use strict';

const campaignService = require('../services/campaignService');
const recallService = require('../services/recallService');
const paymentService = require('../services/paymentService');

/**
 * Background tick (§5.13). Every 10 minutes, run due birthday/follow-up automations, due treatment
 * recalls (§5.22), AND reconcile stuck payments (captured-but-uncredited recovery + abandoned-order
 * cleanup). Cheap when nothing is due (indexed queries); every action is idempotent, so repeated
 * ticks never double-send or double-credit.
 */
let timer = null;

function start(intervalMs = 10 * 60 * 1000) {
  if (timer) return timer;
  timer = setInterval(() => {
    campaignService.runDueCampaigns().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[campaigns] tick error', err.message);
    });
    recallService.processDueRecalls().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[recalls] tick error', err.message);
    });
    paymentService.reconcileStuckPayments().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[payments] reconcile tick error', err.message);
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
