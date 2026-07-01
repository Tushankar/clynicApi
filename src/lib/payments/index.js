'use strict';

const config = require('../../config/env');

/** Payment gateway facade — selects the configured adapter (mock in dev, Razorpay in prod). */
const adapter = config.payments.driver === 'razorpay' ? require('./razorpayAdapter') : require('./mockAdapter');

module.exports = adapter;
