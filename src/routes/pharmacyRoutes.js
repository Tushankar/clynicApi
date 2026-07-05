'use strict';

const express = require('express');
const multer = require('multer');
const ctrl = require('../controllers/pharmacyController');
const { requireRole } = require('../middleware/requireRole');
const { requireFeature } = require('../middleware/requireFeature');
const config = require('../config/env');

/**
 * Pharmacy & Vendor module — Ultra Premium ONLY. Each path group is plan-gated by its §9 feature
 * (all map ONLY to ultra_premium, so every route 403s for non-Ultra clinics regardless of client —
 * server-first isolation, §4.5). Additive: mounted alongside the other routers; nothing existing changes.
 *   /medicines, /inventory  → PHARMACY_MANAGEMENT   (UP-A)
 *   /suppliers, /purchase-orders → SUPPLIER_PROCUREMENT (UP-B)
 *   /expenses               → PHARMACY_ANALYTICS     (UP-B; §9)
 */
const router = express.Router();

// Path-scoped feature gates (run after the global auth on the api router, before the role guards).
router.use('/medicines', requireFeature('PHARMACY_MANAGEMENT'));
router.use('/inventory', requireFeature('PHARMACY_MANAGEMENT'));
router.use('/suppliers', requireFeature('SUPPLIER_PROCUREMENT'));
router.use('/purchase-orders', requireFeature('SUPPLIER_PROCUREMENT'));
router.use('/expenses', requireFeature('PHARMACY_ANALYTICS'));
router.use('/dispense', requireFeature('MEDICINE_DISPENSING'));
router.use('/dispenses', requireFeature('MEDICINE_DISPENSING'));
router.use('/dosage', requireFeature('DOSAGE_MANAGEMENT'));
router.use('/orders', requireFeature('PHARMACY_STOREFRONT'));
router.use('/store-categories', requireFeature('PHARMACY_STOREFRONT'));
router.use('/reports', requireFeature('PHARMACY_ANALYTICS'));

// Clinic owner runs the pharmacy alongside the dedicated pharmacy roles; managers do day-to-day.
const PHARMACY_STAFF = ['owner', 'pharmacy_owner', 'pharmacy_manager'];
const PHARMACY_ADMINS = ['owner', 'pharmacy_owner']; // destructive actions

const uploadImage = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.storage.maxUploadBytes } });

// ---- Medicines (catalog) — PHARMACY_MANAGEMENT ----
router.get('/medicines/meta', requireRole(...PHARMACY_STAFF), ctrl.medicineMeta);
router.get('/medicines', requireRole(...PHARMACY_STAFF), ctrl.listMedicines);
router.post('/medicines', requireRole(...PHARMACY_STAFF), ctrl.createMedicine);
router.get('/medicines/:id', requireRole(...PHARMACY_STAFF), ctrl.getMedicine);
router.patch('/medicines/:id', requireRole(...PHARMACY_STAFF), ctrl.updateMedicine);
router.post('/medicines/:id/image', requireRole(...PHARMACY_STAFF), uploadImage.single('file'), ctrl.uploadMedicineImage);
router.delete('/medicines/:id', requireRole(...PHARMACY_ADMINS), ctrl.removeMedicine);

// ---- Inventory (batches) — PHARMACY_MANAGEMENT ----
router.get('/inventory/summary', requireRole(...PHARMACY_STAFF), ctrl.inventorySummary);
router.get('/inventory/batches', requireRole(...PHARMACY_STAFF), ctrl.listBatches);
router.post('/inventory/batches', requireRole(...PHARMACY_STAFF), ctrl.createBatch);
router.patch('/inventory/batches/:id', requireRole(...PHARMACY_STAFF), ctrl.updateBatch);
router.delete('/inventory/batches/:id', requireRole(...PHARMACY_ADMINS), ctrl.removeBatch);

// ---- Suppliers — SUPPLIER_PROCUREMENT ----
router.get('/suppliers', requireRole(...PHARMACY_STAFF), ctrl.listSuppliers);
router.post('/suppliers', requireRole(...PHARMACY_STAFF), ctrl.createSupplier);
router.get('/suppliers/:id', requireRole(...PHARMACY_STAFF), ctrl.getSupplier);
router.patch('/suppliers/:id', requireRole(...PHARMACY_STAFF), ctrl.updateSupplier);
router.delete('/suppliers/:id', requireRole(...PHARMACY_ADMINS), ctrl.removeSupplier);

// ---- Purchase orders + GRN — SUPPLIER_PROCUREMENT ----
router.get('/purchase-orders', requireRole(...PHARMACY_STAFF), ctrl.listPurchaseOrders);
router.post('/purchase-orders', requireRole(...PHARMACY_STAFF), ctrl.createPurchaseOrder);
router.get('/purchase-orders/:id', requireRole(...PHARMACY_STAFF), ctrl.getPurchaseOrder);
router.patch('/purchase-orders/:id', requireRole(...PHARMACY_STAFF), ctrl.updatePurchaseOrder);
router.post('/purchase-orders/:id/status', requireRole(...PHARMACY_STAFF), ctrl.setPurchaseOrderStatus);
router.post('/purchase-orders/:id/receive', requireRole(...PHARMACY_STAFF), ctrl.receivePurchaseOrder);
router.delete('/purchase-orders/:id', requireRole(...PHARMACY_ADMINS), ctrl.removePurchaseOrder);

// ---- Pharmacy expenses — PHARMACY_ANALYTICS (§9) ----
router.get('/expenses/meta', requireRole(...PHARMACY_STAFF), ctrl.expenseMeta);
router.get('/expenses', requireRole(...PHARMACY_STAFF), ctrl.listExpenses);
router.post('/expenses', requireRole(...PHARMACY_STAFF), ctrl.createExpense);
router.delete('/expenses/:id', requireRole(...PHARMACY_ADMINS), ctrl.removeExpense);

// ---- Dispensing — MEDICINE_DISPENSING ----
router.post('/dispense', requireRole(...PHARMACY_STAFF), ctrl.createDispense);
router.get('/dispenses', requireRole(...PHARMACY_STAFF), ctrl.listDispenses);
router.get('/dispenses/:id', requireRole(...PHARMACY_STAFF), ctrl.getDispense);

// ---- Dosage schedules — DOSAGE_MANAGEMENT ----
router.get('/dosage', requireRole(...PHARMACY_STAFF), ctrl.listDosage);

// ---- Storefront order queue — PHARMACY_STOREFRONT ----
router.get('/orders', requireRole(...PHARMACY_STAFF), ctrl.listStoreOrders);
router.get('/orders/:id', requireRole(...PHARMACY_STAFF), ctrl.getStoreOrder);
router.post('/orders/:id/verify', requireRole(...PHARMACY_STAFF), ctrl.verifyStoreOrder);
router.post('/orders/:id/reject', requireRole(...PHARMACY_STAFF), ctrl.rejectStoreOrder);
router.post('/orders/:id/fulfill', requireRole(...PHARMACY_STAFF), ctrl.fulfillStoreOrder);
router.post('/orders/:id/cancel', requireRole(...PHARMACY_ADMINS), ctrl.cancelStoreOrder);

// ---- Pharmacy reports — PHARMACY_ANALYTICS. FINANCIAL data → owner-level only (spec §3:
// pharmacy managers get no financial reports), unlike the day-to-day PHARMACY_STAFF routes. ----
router.get('/reports', requireRole(...PHARMACY_ADMINS), ctrl.pharmacyReports);

// ---- Storefront categories — PHARMACY_STOREFRONT ----
router.get('/store-categories', requireRole(...PHARMACY_STAFF), ctrl.listStoreCategories);
router.post('/store-categories', requireRole(...PHARMACY_STAFF), ctrl.createStoreCategory);
router.patch('/store-categories/:id', requireRole(...PHARMACY_STAFF), ctrl.updateStoreCategory);
router.post('/store-categories/:id/image', requireRole(...PHARMACY_STAFF), uploadImage.single('file'), ctrl.uploadStoreCategoryImage);
router.delete('/store-categories/:id', requireRole(...PHARMACY_ADMINS), ctrl.removeStoreCategory);

module.exports = router;
