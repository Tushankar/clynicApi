'use strict';

/**
 * SMS adapter (§10.5). Proves the always-throwing stub is replaced by a config-driven adapter that
 * is honestly "not configured" by default (SMS_DRIVER=none) and fails with a CLEAR, actionable error
 * — not the old cryptic "Phase 1" message that surfaced to phone-only patients as a dead end.
 */
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const smsAdapter = require('../src/services/notifications/smsAdapter');

test('SMS is "not configured" by default and send() throws a clear, actionable error', async () => {
  assert.equal(smsAdapter.isConfigured(), false, 'default SMS_DRIVER=none → not configured');
  await assert.rejects(
    () => smsAdapter.send({ to: '9998887777', message: 'hi' }),
    /not configured.*SMS_DRIVER/is,
    'send() names exactly what to set, instead of a cryptic stub message'
  );
  console.log('  ✓ default SMS is not configured; send() throws a clear "set SMS_DRIVER" error');
});
