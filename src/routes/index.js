'use strict';

const express = require('express');
const { attachAuthContext, requireAuth } = require('../middleware/auth');
const meRoutes = require('./meRoutes');
const patientRoutes = require('./patientRoutes');
const doctorRoutes = require('./doctorRoutes');
const appointmentRoutes = require('./appointmentRoutes');
const queueRoutes = require('./queueRoutes');
const branchRoutes = require('./branchRoutes');
const reminderRoutes = require('./reminderRoutes');
const publicRoutes = require('./publicRoutes');
const prescriptionRoutes = require('./prescriptionRoutes');
const clinicalNoteRoutes = require('./clinicalNoteRoutes');
const labRequestRoutes = require('./labRequestRoutes');
const reportRoutes = require('./reportRoutes');
const fileRoutes = require('./fileRoutes');
const searchRoutes = require('./searchRoutes');
const chatRoutes = require('./chatRoutes');
const notificationRoutes = require('./notificationRoutes');
const invoiceRoutes = require('./invoiceRoutes');
const paymentRoutes = require('./paymentRoutes');
const paymentController = require('../controllers/paymentController');
const portalRoutes = require('./portalRoutes');
const subscriptionRoutes = require('./subscriptionRoutes');
const adminRoutes = require('./adminRoutes');
const crmRoutes = require('./crmRoutes');
const analyticsRoutes = require('./analyticsRoutes');

const router = express.Router();

// ---- Public (no auth) -------------------------------------------------------
router.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'clinic-api', phase: 1 });
});
// Public booking API resolves the clinic from the slug — must NOT be behind Clerk.
router.use('/public', publicRoutes);
// Signed file-bytes route — authorized by the signed token, not a Clerk session.
router.use('/files', fileRoutes);
// Payment webhook — public; authorized by the Razorpay signature over the raw body.
router.post('/payments/webhook', paymentController.webhook);
// Patient portal — patient session tokens (not Clerk); mounted before the Clerk gate.
router.use('/portal', portalRoutes);

// ---- Protected (every route below requires a resolved clinic context) -------
const api = express.Router();
api.use(attachAuthContext, requireAuth);

api.use('/me', meRoutes);
api.use('/patients', patientRoutes);
api.use('/doctors', doctorRoutes);
api.use('/branches', branchRoutes);
api.use('/appointments', appointmentRoutes);
api.use('/queue', queueRoutes);
api.use('/reminders', reminderRoutes);
api.use('/prescriptions', prescriptionRoutes);
api.use('/clinical-notes', clinicalNoteRoutes);
api.use('/lab-requests', labRequestRoutes);
api.use('/reports', reportRoutes);
api.use('/search', searchRoutes);
api.use('/chat', chatRoutes);
api.use('/notifications', notificationRoutes);
api.use('/invoices', invoiceRoutes);
api.use('/payments', paymentRoutes);
api.use('/subscription', subscriptionRoutes);
api.use('/admin', adminRoutes);
api.use('/crm', crmRoutes);
api.use('/analytics', analyticsRoutes);

router.use(api);

module.exports = router;
