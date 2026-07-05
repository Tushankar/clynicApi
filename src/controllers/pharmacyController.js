'use strict';

const asyncHandler = require('../utils/asyncHandler');
const medicineService = require('../services/pharmacyMedicineService');
const inventoryService = require('../services/pharmacyInventoryService');
const supplierService = require('../services/pharmacySupplierService');
const purchaseOrderService = require('../services/pharmacyPurchaseOrderService');
const expenseService = require('../services/pharmacyExpenseService');
const dispenseService = require('../services/dispenseService');
const dosageService = require('../services/pharmacyDosageService');

/* ------------------------------- Medicines (catalog) ------------------------------- */

const listMedicines = asyncHandler(async (req, res) => {
  res.json(await medicineService.list(req.ctx, { search: req.query.search, category: req.query.category, active: req.query.active }));
});
const getMedicine = asyncHandler(async (req, res) => {
  res.json(await medicineService.get(req.ctx, req.params.id));
});
const createMedicine = asyncHandler(async (req, res) => {
  res.status(201).json(await medicineService.create(req.ctx, req.body));
});
const updateMedicine = asyncHandler(async (req, res) => {
  res.json(await medicineService.update(req.ctx, req.params.id, req.body));
});
const removeMedicine = asyncHandler(async (req, res) => {
  await medicineService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});
const uploadMedicineImage = asyncHandler(async (req, res) => {
  res.json(await medicineService.uploadImage(req.ctx, req.params.id, req.file));
});
const medicineMeta = asyncHandler(async (req, res) => {
  res.json({ forms: medicineService.FORMS, units: medicineService.UNITS, scheduleClasses: medicineService.SCHEDULE_CLASSES });
});

/* ------------------------------- Inventory (batches) ------------------------------- */

const listBatches = asyncHandler(async (req, res) => {
  res.json(await inventoryService.listBatches(req.ctx, { medicineId: req.query.medicineId, branchId: req.query.branchId }));
});
const createBatch = asyncHandler(async (req, res) => {
  res.status(201).json(await inventoryService.createBatch(req.ctx, req.body));
});
const updateBatch = asyncHandler(async (req, res) => {
  res.json(await inventoryService.updateBatch(req.ctx, req.params.id, req.body));
});
const removeBatch = asyncHandler(async (req, res) => {
  await inventoryService.removeBatch(req.ctx, req.params.id);
  res.json({ ok: true });
});
const inventorySummary = asyncHandler(async (req, res) => {
  res.json(await inventoryService.summary(req.ctx));
});

/* --------------------------------- Suppliers (UP-B) --------------------------------- */

const listSuppliers = asyncHandler(async (req, res) => {
  res.json(await supplierService.list(req.ctx, { search: req.query.search, active: req.query.active }));
});
const getSupplier = asyncHandler(async (req, res) => {
  res.json(await supplierService.get(req.ctx, req.params.id));
});
const createSupplier = asyncHandler(async (req, res) => {
  res.status(201).json(await supplierService.create(req.ctx, req.body));
});
const updateSupplier = asyncHandler(async (req, res) => {
  res.json(await supplierService.update(req.ctx, req.params.id, req.body));
});
const removeSupplier = asyncHandler(async (req, res) => {
  await supplierService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});

/* ------------------------------ Purchase orders (UP-B) ------------------------------ */

const listPurchaseOrders = asyncHandler(async (req, res) => {
  res.json(await purchaseOrderService.list(req.ctx, { status: req.query.status, supplierId: req.query.supplierId }));
});
const getPurchaseOrder = asyncHandler(async (req, res) => {
  res.json(await purchaseOrderService.get(req.ctx, req.params.id));
});
const createPurchaseOrder = asyncHandler(async (req, res) => {
  res.status(201).json(await purchaseOrderService.create(req.ctx, req.body));
});
const updatePurchaseOrder = asyncHandler(async (req, res) => {
  res.json(await purchaseOrderService.update(req.ctx, req.params.id, req.body));
});
const setPurchaseOrderStatus = asyncHandler(async (req, res) => {
  res.json(await purchaseOrderService.setStatus(req.ctx, req.params.id, req.body.status));
});
const receivePurchaseOrder = asyncHandler(async (req, res) => {
  res.json(await purchaseOrderService.receive(req.ctx, req.params.id, req.body));
});
const removePurchaseOrder = asyncHandler(async (req, res) => {
  await purchaseOrderService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});

/* --------------------------------- Expenses (UP-B) ---------------------------------- */

const listExpenses = asyncHandler(async (req, res) => {
  res.json(await expenseService.list(req.ctx, { from: req.query.from, to: req.query.to, type: req.query.type }));
});
const createExpense = asyncHandler(async (req, res) => {
  res.status(201).json(await expenseService.create(req.ctx, req.body));
});
const removeExpense = asyncHandler(async (req, res) => {
  await expenseService.remove(req.ctx, req.params.id);
  res.json({ ok: true });
});
const expenseMeta = asyncHandler(async (req, res) => {
  res.json({ categories: expenseService.OTHER_CATEGORIES });
});

/* ---------------------------- Dispensing & dosage (UP-C) ---------------------------- */

const createDispense = asyncHandler(async (req, res) => {
  res.status(201).json(await dispenseService.dispense(req.ctx, req.body));
});
const listDispenses = asyncHandler(async (req, res) => {
  res.json(await dispenseService.list(req.ctx, { patientId: req.query.patientId, prescriptionId: req.query.prescriptionId }));
});
const getDispense = asyncHandler(async (req, res) => {
  res.json(await dispenseService.getById(req.ctx, req.params.id));
});
const listDosage = asyncHandler(async (req, res) => {
  res.json(await dosageService.listForPatient(req.ctx, req.query.patientId));
});

module.exports = {
  listMedicines,
  getMedicine,
  createMedicine,
  updateMedicine,
  removeMedicine,
  uploadMedicineImage,
  medicineMeta,
  listBatches,
  createBatch,
  updateBatch,
  removeBatch,
  inventorySummary,
  // UP-B — suppliers
  listSuppliers,
  getSupplier,
  createSupplier,
  updateSupplier,
  removeSupplier,
  // UP-B — purchase orders
  listPurchaseOrders,
  getPurchaseOrder,
  createPurchaseOrder,
  updatePurchaseOrder,
  setPurchaseOrderStatus,
  receivePurchaseOrder,
  removePurchaseOrder,
  // UP-B — expenses
  listExpenses,
  createExpense,
  removeExpense,
  expenseMeta,
  // UP-C — dispensing & dosage
  createDispense,
  listDispenses,
  getDispense,
  listDosage,
};
