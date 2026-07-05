'use strict';

/**
 * UP-A tier-isolation proof (Pharmacy & Vendor module, Ultra Premium).
 *
 * The STOP-after-UP-A gate: proves the module is fully additive and server-first gated.
 *
 *   Part 1 — Gating math (no DB): adding ultra_premium leaves basic/standard/premium
 *            resolution BYTE-FOR-BYTE identical; ultra is a strict superset of premium;
 *            PLANS order preserved; limits present (no Basic-cap fallback); pharmacy
 *            features locked for every lower tier.
 *   Part 2 — Server-first lock (no DB): requireFeature('PHARMACY_MANAGEMENT') 403s a
 *            premium clinic and passes an ultra clinic — the real lock, client-independent.
 *   Part 3 — Data layer (in-memory Mongo): the new Medicine/InventoryBatch collections are
 *            tenant-isolated, soft-deletable, audited; live availability excludes expired
 *            stock. No cross-clinic bleed.
 *
 * Run: npm test   (node --test; spins up mongodb-memory-server)
 */

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { PLANS, FEATURES, planHasFeature, resolveFeatures, limitsForPlan } = require('../src/config/plans');
const { requireFeature } = require('../src/middleware/requireFeature');

const PHARMACY_KEYS = [
  'PHARMACY_MANAGEMENT', 'SUPPLIER_PROCUREMENT', 'MEDICINE_DISPENSING',
  'DOSAGE_MANAGEMENT', 'PHARMACY_STOREFRONT', 'PHARMACY_ANALYTICS',
];
const LOWER_TIERS = ['basic', 'standard', 'premium'];

/* ============================ Part 1 — gating math ============================ */

test('(1a) lower tiers are byte-for-byte unaffected — planHasFeature == raw FEATURES membership', () => {
  // The ONLY change to planHasFeature is a branch guarded by plan==='ultra_premium'.
  // So for every existing tier and EVERY feature key, resolution must still equal the
  // literal array membership — no key flipped, none added, none removed.
  for (const plan of LOWER_TIERS) {
    for (const key of Object.keys(FEATURES)) {
      assert.equal(
        planHasFeature(plan, key),
        FEATURES[key].includes(plan),
        `feature ${key} for ${plan} must equal raw membership (additive-only)`
      );
    }
  }
  console.log('  ✓ (1a) basic/standard/premium resolve exactly as literal FEATURES membership — zero drift');
});

test('(1b) pharmacy features are locked for every non-Ultra tier', () => {
  for (const plan of LOWER_TIERS) {
    for (const key of PHARMACY_KEYS) {
      assert.equal(planHasFeature(plan, key), false, `${key} must be locked for ${plan}`);
    }
  }
  // …and unlocked for ultra_premium.
  for (const key of PHARMACY_KEYS) {
    assert.equal(planHasFeature('ultra_premium', key), true, `${key} must be unlocked for ultra_premium`);
  }
  console.log('  ✓ (1b) all 6 pharmacy features locked below Ultra, unlocked at Ultra');
});

test('(1c) ultra_premium is a STRICT superset of premium', () => {
  const prem = resolveFeatures('premium');
  const ultra = resolveFeatures('ultra_premium');
  const missing = Object.keys(prem).filter((k) => prem[k] && !ultra[k]);
  assert.deepEqual(missing, [], 'ultra must inherit every premium feature');
  const extra = Object.keys(ultra).filter((k) => ultra[k] && !prem[k]);
  assert.deepEqual(extra.sort(), [...PHARMACY_KEYS].sort(), 'ultra adds exactly the pharmacy features over premium');
  console.log('  ✓ (1c) ultra ⊇ premium, and adds exactly the 6 pharmacy features');
});

test('(1d) PLANS order preserved (upgrade/downgrade math is load-bearing)', () => {
  assert.equal(PLANS.indexOf('basic'), 0);
  assert.equal(PLANS.indexOf('standard'), 1);
  assert.equal(PLANS.indexOf('premium'), 2);
  assert.equal(PLANS.indexOf('ultra_premium'), PLANS.length - 1, 'ultra_premium must rank highest (appended last)');
  console.log('  ✓ (1d) tier ranks unchanged; ultra_premium appended at the top rank');
});

test('(1e) LIMITS.ultra_premium exists (no silent Basic-cap fallback)', () => {
  const l = limitsForPlan('ultra_premium');
  const basic = limitsForPlan('basic');
  assert.notDeepEqual(l, basic, 'ultra must not fall back to Basic caps');
  assert.equal(Number.isFinite(l.maxDoctors), false, 'ultra doctors unlimited');
  assert.equal(Number.isFinite(l.maxBranches), false, 'ultra branches unlimited');
  console.log('  ✓ (1e) ultra limits are explicit + unlimited (avoids the limitsForPlan Basic fallback trap)');
});

/* ===================== Part 2 — server-first requireFeature ==================== */

function runGuard(plan) {
  const guard = requireFeature('PHARMACY_MANAGEMENT');
  const req = { clinic: { subscriptionPlan: plan } };
  const result = { status: null, body: null, nextCalled: false };
  const res = {
    status(code) { result.status = code; return this; },
    json(obj) { result.body = obj; return this; },
  };
  guard(req, res, () => { result.nextCalled = true; });
  return result;
}

test('(2) requireFeature is the real lock — 403 for premium, pass for ultra', () => {
  const prem = runGuard('premium');
  assert.equal(prem.nextCalled, false, 'premium must NOT pass the pharmacy gate');
  assert.equal(prem.status, 403);
  assert.equal(prem.body.error, 'upgrade_required');
  assert.equal(prem.body.feature, 'PHARMACY_MANAGEMENT');

  for (const plan of ['basic', 'standard']) {
    assert.equal(runGuard(plan).status, 403, `${plan} must be 403 on pharmacy routes`);
  }

  const ultra = runGuard('ultra_premium');
  assert.equal(ultra.nextCalled, true, 'ultra must pass the pharmacy gate');
  assert.equal(ultra.status, null, 'ultra must not receive an error status');
  console.log('  ✓ (2) server 403s basic/standard/premium on /pharmacy, passes ultra — client-independent');
});

/* ========================= Part 3 — data-layer isolation ====================== */

let mongod;
let mongoose;
let Medicine;
let InventoryBatch;
let AuditLog;
let Supplier;
let PurchaseOrder;
let PharmacyExpense;
let Patient;
let Prescription;
let Dispense;
let DosageSchedule;
let Invoice;
let Clinic;
let MedicineCategory;
let MedicineOrder;
let tenantRepo;
let medicineService;
let inventoryService;
let supplierService;
let purchaseOrderService;
let expenseService;
let dispenseService;
let timelineService;
let invoiceService;
let storeService;
let storeOrderService;
let storeOpsService;
let websiteService;

const ctxA = { clinicId: 'org_ultraA', actorId: 'user_a1', actorRole: 'pharmacy_owner' };
const ctxB = { clinicId: 'org_ultraB', actorId: 'user_b1', actorRole: 'pharmacy_owner' };

before(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongoose = require('mongoose');
  ({ Medicine, InventoryBatch, AuditLog, Supplier, PurchaseOrder, PharmacyExpense, Patient, Prescription, Dispense, DosageSchedule, Invoice, Clinic, MedicineCategory, MedicineOrder } = require('../src/models'));
  ({ tenantRepo } = require('../src/lib/TenantRepository'));
  medicineService = require('../src/services/pharmacyMedicineService');
  inventoryService = require('../src/services/pharmacyInventoryService');
  supplierService = require('../src/services/pharmacySupplierService');
  purchaseOrderService = require('../src/services/pharmacyPurchaseOrderService');
  expenseService = require('../src/services/pharmacyExpenseService');
  dispenseService = require('../src/services/dispenseService');
  timelineService = require('../src/services/timelineService');
  invoiceService = require('../src/services/invoiceService');
  storeService = require('../src/services/storeService');
  storeOrderService = require('../src/services/storeOrderService');
  storeOpsService = require('../src/services/storeOpsService');
  websiteService = require('../src/services/websiteService');
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await Medicine.init();
  await InventoryBatch.init();
  await AuditLog.init();
  await Supplier.init();
  await PurchaseOrder.init();
  await PharmacyExpense.init();
  await Patient.init();
  await Prescription.init();
  await Dispense.init();
  await DosageSchedule.init();
  await Invoice.init();
  await Clinic.init();
  await MedicineCategory.init();
  await MedicineOrder.init();
});

after(async () => {
  if (mongoose) await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

beforeEach(async () => {
  await Medicine.deleteMany({});
  await InventoryBatch.deleteMany({});
  await AuditLog.deleteMany({});
  await Supplier.deleteMany({});
  await PurchaseOrder.deleteMany({});
  await PharmacyExpense.deleteMany({});
  await Patient.deleteMany({});
  await Prescription.deleteMany({});
  await Dispense.deleteMany({});
  await DosageSchedule.deleteMany({});
  await Invoice.deleteMany({});
  await Clinic.deleteMany({});
  await MedicineCategory.deleteMany({});
  await MedicineOrder.deleteMany({});
});

// ---- UP-C helpers: seed a patient + prescription + a stocked medicine ----
async function seedRxAndStock(ctx, { name = 'Med', reorderLevel = 0, batches = [] } = {}) {
  const patient = await tenantRepo(Patient, ctx).create({ name: 'Test Patient', patientCode: `P-${name}` });
  const rx = await tenantRepo(Prescription, ctx).create({
    patientId: patient._id, doctorId: new mongoose.Types.ObjectId(), patientName: 'Test Patient', items: [{ drug: name }],
  });
  const med = await medicineService.create(ctx, { name, reorderLevel, sellingPrice: 10, gstRate: 12 });
  for (const b of batches) {
    await inventoryService.createBatch(ctx, { medicineId: med._id, batchNo: b.batchNo, expiryDate: b.expiryDate, quantityInStock: b.qty, purchaseUnitCost: 1 });
  }
  return { patient, rx, med };
}

test('(3a) Medicine + InventoryBatch are tenant-isolated (no cross-clinic bleed)', async () => {
  const medA = await medicineService.create(ctxA, { name: 'Paracetamol 500mg (A)' });
  const medB = await medicineService.create(ctxB, { name: 'Amoxicillin 250mg (B)' });

  const listA = await medicineService.list(ctxA);
  assert.equal(listA.items.length, 1, 'clinic A sees only its own medicine');
  assert.equal(listA.items[0].name, 'Paracetamol 500mg (A)');

  // A cannot read B's medicine by id.
  await assert.rejects(() => medicineService.get(ctxA, medB._id), /not found/i, 'A must not read B medicine');

  // Batches are isolated too.
  await inventoryService.createBatch(ctxA, { medicineId: medA._id, expiryDate: '2030-01-01', quantityInStock: 10, purchaseUnitCost: 2 });
  await inventoryService.createBatch(ctxB, { medicineId: medB._id, expiryDate: '2030-01-01', quantityInStock: 99, purchaseUnitCost: 5 });
  const batchesA = await inventoryService.listBatches(ctxA);
  assert.equal(batchesA.items.length, 1, 'clinic A sees only its own batch');
  assert.equal(batchesA.items[0].quantityInStock, 10);
  console.log('  ✓ (3a) medicines + batches strictly clinic-scoped; cross-clinic reads blocked');
});

test('(3b) live availability excludes expired stock, FEFO-visible, sums non-expired', async () => {
  const med = await medicineService.create(ctxA, { name: 'Vitamin C', reorderLevel: 5 });
  await inventoryService.createBatch(ctxA, { medicineId: med._id, batchNo: 'GOOD', expiryDate: '2035-01-01', quantityInStock: 8, purchaseUnitCost: 1 });
  await inventoryService.createBatch(ctxA, { medicineId: med._id, batchNo: 'EXPIRED', expiryDate: '2000-01-01', quantityInStock: 100, purchaseUnitCost: 1 });

  const view = await medicineService.get(ctxA, med._id);
  assert.equal(view.available, 8, 'availability must exclude the expired batch (8, not 108)');
  assert.equal(view.expiredQty, 100, 'expired quantity tracked separately');
  assert.equal(view.batchCount, 2);

  const summary = await inventoryService.summary(ctxA);
  assert.equal(summary.expiredBatches, 1);
  assert.equal(summary.stockValue, 8, 'valuation counts only non-expired stock (8×1)');

  // Expired-batch listing carries the right status.
  const batches = await inventoryService.listBatches(ctxA, { medicineId: med._id });
  const expired = batches.items.find((b) => b.batchNo === 'EXPIRED');
  assert.equal(expired.expiryStatus, 'expired');
  console.log('  ✓ (3b) availability = Σ non-expired qty; expired excluded from stock + valuation');
});

test('(3c) soft delete + audit via the tenant repo (hard rules 6, 7)', async () => {
  const med = await medicineService.create(ctxA, { name: 'Ibuprofen 400mg' });
  await medicineService.update(ctxA, med._id, { brand: 'Brufen' });
  await medicineService.remove(ctxA, med._id);

  // Gone from default listing…
  const list = await medicineService.list(ctxA);
  assert.equal(list.items.length, 0, 'soft-deleted medicine hidden from default listing');
  // …but physically retained (non-destructive — survives downgrade/re-upgrade).
  const raw = await Medicine.findById(med._id).lean();
  assert.ok(raw && raw.deletedAt instanceof Date, 'record retained with deletedAt set');
  assert.equal(raw.deletedBy, 'user_a1');

  const actions = (await AuditLog.find({ entityType: 'Medicine', entityId: med._id }).sort({ createdAt: 1 }).lean()).map((l) => l.action);
  assert.deepEqual(actions, ['create', 'update', 'delete'], 'catalog writes are audited create/update/delete');
  console.log('  ✓ (3c) pharmacy data soft-deleted (retained) + fully audited via the shared repo');
});

test('(3d) compliance: Schedule H/H1/X forces prescriptionRequired', async () => {
  const otc = await medicineService.create(ctxA, { name: 'Cetirizine', scheduleClass: 'OTC' });
  assert.equal(otc.prescriptionRequired, false);
  const sched = await medicineService.create(ctxA, { name: 'Alprazolam', scheduleClass: 'H1', prescriptionRequired: false });
  assert.equal(sched.prescriptionRequired, true, 'Schedule H1 must force prescriptionRequired even if sent false');
  console.log('  ✓ (3d) H/H1/X medicines are always Rx-required regardless of the submitted flag');
});

test('(3e) SKU is unique among LIVE medicines but a soft-deleted one frees its SKU', async () => {
  const a = await medicineService.create(ctxA, { name: 'Para A', sku: 'PARA-500' });
  // Two LIVE medicines cannot share a SKU.
  await assert.rejects(() => medicineService.create(ctxA, { name: 'Para dup', sku: 'PARA-500' }), /SKU already exists/i);
  // Soft-delete the first → its SKU must become reusable (soft-delete must not fetter live data).
  await medicineService.remove(ctxA, a._id);
  const reused = await medicineService.create(ctxA, { name: 'Para B', sku: 'PARA-500' });
  assert.equal(reused.sku, 'PARA-500', 'SKU must be reusable after the holder is soft-deleted');
  // Same SKU is still fine in a DIFFERENT clinic (per-clinic uniqueness).
  const other = await medicineService.create(ctxB, { name: 'Para (B clinic)', sku: 'PARA-500' });
  assert.equal(other.sku, 'PARA-500');
  console.log('  ✓ (3e) SKU unique per clinic among live meds; soft-deleted rows release their SKU');
});

test('(3f) createBatch rejects a branchId that is not the clinic\'s own', async () => {
  const med = await medicineService.create(ctxA, { name: 'Saline' });
  const foreign = new mongoose.Types.ObjectId().toString(); // not a branch of clinic A
  await assert.rejects(
    () => inventoryService.createBatch(ctxA, { medicineId: med._id, expiryDate: '2030-01-01', quantityInStock: 5, branchId: foreign }),
    /invalid branch/i,
    'a foreign/unknown branchId must be rejected'
  );
  // Without branchId it auto-uses the clinic's primary branch (no orphaned stock).
  const ok = await inventoryService.createBatch(ctxA, { medicineId: med._id, expiryDate: '2030-01-01', quantityInStock: 5 });
  assert.ok(ok.branchId, 'batch attaches to the primary branch when none supplied');
  console.log('  ✓ (3f) createBatch validates branch ownership; foreign branchId → 400, default → primary branch');
});

/* ===================== Part 4 — UP-B procurement & expenses ==================== */

test('(4a) suppliers are tenant-isolated + soft-deletable + audited', async () => {
  const sA = await supplierService.create(ctxA, { name: 'MediSupply (A)' });
  const sB = await supplierService.create(ctxB, { name: 'OtherDist (B)' });
  const listA = await supplierService.list(ctxA);
  assert.equal(listA.items.length, 1, 'clinic A sees only its own supplier');
  await assert.rejects(() => supplierService.get(ctxA, sB._id), /not found/i, 'A must not read B\'s supplier');
  await supplierService.remove(ctxA, sA._id);
  assert.equal((await supplierService.list(ctxA)).items.length, 0, 'soft-deleted supplier hidden');
  const raw = await Supplier.findById(sA._id).lean();
  assert.ok(raw && raw.deletedAt, 'supplier retained with deletedAt (non-destructive)');
  console.log('  ✓ (4a) suppliers clinic-scoped, soft-deleted (retained), no cross-clinic bleed');
});

test('(4b) GRN: receiving a PO creates inventory batches + a purchase expense + marks received', async () => {
  const med = await medicineService.create(ctxA, { name: 'Amoxicillin 500', reorderLevel: 100 });
  const sup = await supplierService.create(ctxA, { name: 'MediSupply' });
  const po = await purchaseOrderService.create(ctxA, {
    supplierId: sup._id,
    items: [{ medicineId: med._id, qty: 50, unitCost: 4, batchNo: 'B1', expiryDate: '2031-01-01' }],
  });
  assert.match(po.poNumber, /^PO\d{5}$/, 'PO gets a sequential number');
  assert.equal(po.totalCost, 200, 'totalCost = 50 × 4');
  assert.equal(po.status, 'draft');

  // Before receipt: no stock, no expense.
  assert.equal((await medicineService.get(ctxA, med._id)).available, 0);

  const received = await purchaseOrderService.receive(ctxA, po._id, {});
  assert.equal(received.status, 'received');
  assert.ok(received.receivedAt, 'receivedAt set');

  // Stock now available, linked to the PO.
  const view = await medicineService.get(ctxA, med._id);
  assert.equal(view.available, 50, 'GRN added 50 units to availability');
  const batches = await InventoryBatch.find({ clinicId: ctxA.clinicId, purchaseOrderId: po._id }).lean();
  assert.equal(batches.length, 1, 'one batch created, linked to the PO');
  assert.equal(batches[0].quantityInStock, 50);

  // Purchase expense recorded.
  const exp = await expenseService.list(ctxA, { type: 'purchase' });
  assert.equal(exp.items.length, 1);
  assert.equal(exp.items[0].amount, 200, 'purchase expense = PO total');
  assert.equal(exp.purchases, 200);
  console.log('  ✓ (4b) GRN adds stock (linked to PO) + records the purchase expense + marks received');
});

test('(4c) GRN is idempotent — a second receive is rejected and stock is NOT doubled', async () => {
  const med = await medicineService.create(ctxA, { name: 'ORS' });
  const sup = await supplierService.create(ctxA, { name: 'Dist' });
  const po = await purchaseOrderService.create(ctxA, { supplierId: sup._id, items: [{ medicineId: med._id, qty: 20, unitCost: 1, expiryDate: '2031-01-01' }] });
  await purchaseOrderService.receive(ctxA, po._id, {});
  await assert.rejects(() => purchaseOrderService.receive(ctxA, po._id, {}), /already received/i, 'second receive must be rejected');
  assert.equal((await medicineService.get(ctxA, med._id)).available, 20, 'stock not doubled by the second attempt');
  const batches = await InventoryBatch.find({ clinicId: ctxA.clinicId, purchaseOrderId: po._id, deletedAt: null }).lean();
  assert.equal(batches.length, 1, 'exactly one batch exists for the PO');
  console.log('  ✓ (4c) double-receive rejected; stock never doubled');
});

test('(4d) GRN requires an expiry date on every line (never stock without expiry, §5)', async () => {
  const med = await medicineService.create(ctxA, { name: 'NoExpiryMed' });
  const sup = await supplierService.create(ctxA, { name: 'Dist' });
  const po = await purchaseOrderService.create(ctxA, { supplierId: sup._id, items: [{ medicineId: med._id, qty: 10, unitCost: 2 }] }); // no expiry
  await assert.rejects(() => purchaseOrderService.receive(ctxA, po._id, {}), /expiry date is required/i);
  // Supplying expiry at receipt time succeeds.
  const ok = await purchaseOrderService.receive(ctxA, po._id, { items: [{ expiryDate: '2031-06-01', batchNo: 'LATE' }] });
  assert.equal(ok.status, 'received');
  assert.equal((await medicineService.get(ctxA, med._id)).available, 10);
  console.log('  ✓ (4d) receive blocks lines without expiry; receive-time expiry override works');
});

test('(4e) purchase expenses cannot be deleted via the expense service; manual ones can', async () => {
  const med = await medicineService.create(ctxA, { name: 'Vitamin D' });
  const sup = await supplierService.create(ctxA, { name: 'Dist' });
  const po = await purchaseOrderService.create(ctxA, { supplierId: sup._id, items: [{ medicineId: med._id, qty: 5, unitCost: 3, expiryDate: '2031-01-01' }] });
  await purchaseOrderService.receive(ctxA, po._id, {});
  const purchaseExp = (await expenseService.list(ctxA, { type: 'purchase' })).items[0];
  await assert.rejects(() => expenseService.remove(ctxA, purchaseExp._id), /cannot be deleted/i, 'purchase expense is protected');

  const manual = await expenseService.create(ctxA, { amount: 500, category: 'rent', note: 'Shop rent' });
  const removed = await expenseService.remove(ctxA, manual._id);
  assert.ok(removed, 'manual "other" expense can be deleted');
  console.log('  ✓ (4e) purchase expenses protected from deletion; manual expenses removable');
});

test('(4f) procurement routes are gated (requireFeature units) for non-Ultra tiers', () => {
  const { requireFeature } = require('../src/middleware/requireFeature');
  const check = (feature, plan) => {
    const guard = requireFeature(feature);
    let status = null; let next = false;
    guard({ clinic: { subscriptionPlan: plan } }, { status(c) { status = c; return this; }, json() { return this; } }, () => { next = true; });
    return next ? 'pass' : status;
  };
  for (const feature of ['SUPPLIER_PROCUREMENT', 'PHARMACY_ANALYTICS']) {
    for (const plan of ['basic', 'standard', 'premium']) assert.equal(check(feature, plan), 403, `${feature} must 403 for ${plan}`);
    assert.equal(check(feature, 'ultra_premium'), 'pass', `${feature} must pass for ultra`);
  }
  console.log('  ✓ (4f) SUPPLIER_PROCUREMENT + PHARMACY_ANALYTICS 403 for basic/standard/premium, pass for ultra');
});

test('(4g) expense totals aggregate the FULL filtered set across purchase + other', async () => {
  await expenseService.create(ctxA, { amount: 100, category: 'rent', note: 'rent' });
  await expenseService.create(ctxA, { amount: 50, category: 'utilities', note: 'power' });
  const med = await medicineService.create(ctxA, { name: 'AggMed' });
  const sup = await supplierService.create(ctxA, { name: 'AggDist' });
  const po = await purchaseOrderService.create(ctxA, { supplierId: sup._id, items: [{ medicineId: med._id, qty: 10, unitCost: 3, expiryDate: '2031-01-01' }] });
  await purchaseOrderService.receive(ctxA, po._id, {}); // records a ₹30 purchase expense

  const res = await expenseService.list(ctxA, {});
  // Totals come from a clinic-scoped $group aggregation over ALL matched rows (not the reduce over a
  // 500-row display page), so the headline P&L figures are correct at any volume.
  assert.equal(res.purchases, 30, 'purchases total');
  assert.equal(res.other, 150, 'other total (100 + 50)');
  assert.equal(res.total, 180, 'grand total');

  // Date filter: a comfortably-later inclusive `to` returns everything (TZ-robust end-of-day check).
  const filtered = await expenseService.list(ctxA, { to: '2099-12-31', type: 'other' });
  assert.equal(filtered.total, 150, 'type + date filter flows into the aggregation');
  console.log('  ✓ (4g) expense KPI totals aggregate the full set (purchase + other), filter-aware');
});

/* ===================== Part 5 — UP-C dispensing & dosage ==================== */

test('(5a) dispense deducts FEFO (earliest-expiry first), never from an expired batch', async () => {
  const { rx, med } = await seedRxAndStock(ctxA, {
    name: 'Amox',
    batches: [
      { batchNo: 'FAR', expiryDate: '2035-01-01', qty: 100 },
      { batchNo: 'NEAR', expiryDate: '2030-01-01', qty: 30 }, // earliest in-date → used first
      { batchNo: 'DEAD', expiryDate: '2000-01-01', qty: 999 }, // expired → never touched
    ],
  });
  const d = await dispenseService.dispense(ctxA, { prescriptionId: rx._id, items: [{ medicineId: med._id, qty: 40, dosage: '1-0-1', durationDays: 5 }] });
  // 30 from NEAR (earliest), 10 from FAR; DEAD (expired) untouched.
  const near = await InventoryBatch.findOne({ clinicId: ctxA.clinicId, medicineId: med._id, batchNo: 'NEAR' }).lean();
  const far = await InventoryBatch.findOne({ clinicId: ctxA.clinicId, medicineId: med._id, batchNo: 'FAR' }).lean();
  const dead = await InventoryBatch.findOne({ clinicId: ctxA.clinicId, medicineId: med._id, batchNo: 'DEAD' }).lean();
  assert.equal(near.quantityInStock, 0, 'earliest-expiry batch drained first');
  assert.equal(far.quantityInStock, 90, 'later batch used only for the remainder');
  assert.equal(dead.quantityInStock, 999, 'expired batch never dispensed');
  assert.equal((await medicineService.get(ctxA, med._id)).available, 90, 'availability reduced by 40');
  assert.equal(d.items[0].allocations.length, 2, 'allocation split across the two in-date batches');
  console.log('  ✓ (5a) FEFO deduction across batches; expired stock never used');
});

test('(5b) never oversell — shortfall is rejected and rolled back; concurrent dispenses cannot go negative', async () => {
  const { rx, med } = await seedRxAndStock(ctxA, { name: 'ORS', batches: [{ batchNo: 'B', expiryDate: '2035-01-01', qty: 10 }] });
  // Asking for more than in-date stock → 409, and stock is fully restored (rollback).
  await assert.rejects(() => dispenseService.dispense(ctxA, { prescriptionId: rx._id, items: [{ medicineId: med._id, qty: 25 }] }), /insufficient/i);
  assert.equal((await InventoryBatch.findOne({ clinicId: ctxA.clinicId, batchNo: 'B' }).lean()).quantityInStock, 10, 'failed dispense left stock intact');

  // 3 concurrent dispenses of 5 each against a batch of 10 → at most 2 succeed; stock never negative.
  const results = await Promise.allSettled([5, 5, 5].map(() => dispenseService.dispense(ctxA, { prescriptionId: rx._id, items: [{ medicineId: med._id, qty: 5 }] })));
  const ok = results.filter((r) => r.status === 'fulfilled').length;
  const finalQty = (await InventoryBatch.findOne({ clinicId: ctxA.clinicId, batchNo: 'B' }).lean()).quantityInStock;
  assert.ok(finalQty >= 0, 'stock never goes negative');
  assert.equal(10 - finalQty, ok * 5, 'exactly the successful dispenses were deducted (no double-deduct, no oversell)');
  assert.ok(ok <= 2, 'cannot dispense more than the 10 in stock (max two 5-unit dispenses)');
  console.log(`  ✓ (5b) oversell rejected + rolled back; under concurrency ${ok} of 3 succeeded, stock=${finalQty} (never negative)`);
});

test('(5c) Rx enforcement — a dispense requires a valid clinic prescription', async () => {
  const { med } = await seedRxAndStock(ctxA, { name: 'AlpX', batches: [{ batchNo: 'B', expiryDate: '2035-01-01', qty: 10 }] });
  // Missing prescription → 400.
  await assert.rejects(() => dispenseService.dispense(ctxA, { items: [{ medicineId: med._id, qty: 1 }] }), /prescription is required/i);
  // Unknown / another clinic's prescription → 404 (tenant-scoped).
  const otherRx = await tenantRepo(Prescription, ctxB).create({ patientId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(), items: [{ drug: 'x' }] });
  await assert.rejects(() => dispenseService.dispense(ctxA, { prescriptionId: otherRx._id, items: [{ medicineId: med._id, qty: 1 }] }), /not found/i);
  console.log('  ✓ (5c) dispensing without/with a foreign prescription is rejected (Rx enforcement, §5.3)');
});

test('(5d) a dispense creates the record + dosage schedule + GST invoice, all clinic-scoped', async () => {
  const { rx, med, patient } = await seedRxAndStock(ctxA, { name: 'Ibu', batches: [{ batchNo: 'B', expiryDate: '2035-01-01', qty: 20 }] });
  const d = await dispenseService.dispense(ctxA, { prescriptionId: rx._id, items: [{ medicineId: med._id, qty: 4, unitPrice: 10, dosage: '1-1-1', durationDays: 3 }] });
  assert.ok(d.invoiceId, 'a GST invoice was created and linked');
  assert.equal(d.total, 40, 'dispense total = 4 × ₹10');

  const inv = await Invoice.findById(d.invoiceId).lean();
  assert.equal(inv.clinicId, ctxA.clinicId, 'invoice is clinic-scoped');
  assert.equal(inv.gstAmount, 4.8, 'GST 12% applied (₹40 × 12% = ₹4.80)');
  assert.equal(inv.total, 44.8);

  const schedules = await DosageSchedule.find({ clinicId: ctxA.clinicId, patientId: patient._id }).lean();
  assert.equal(schedules.length, 1, 'a dosage schedule was created');
  assert.equal(schedules[0].dosage, '1-1-1');
  assert.ok(schedules[0].endDate, 'endDate computed from durationDays');
  console.log('  ✓ (5d) dispense → dispense record + dosage schedule + linked GST invoice (blended rate correct)');
});

test('(5e) dispenses appear on the timeline ONLY when pharmacy is included (non-Ultra unchanged)', async () => {
  const { rx, med, patient } = await seedRxAndStock(ctxA, { name: 'Cet', batches: [{ batchNo: 'B', expiryDate: '2035-01-01', qty: 10 }] });
  await dispenseService.dispense(ctxA, { prescriptionId: rx._id, items: [{ medicineId: med._id, qty: 2 }] });

  const without = await timelineService.getTimeline(ctxA, patient._id); // default: no pharmacy (non-Ultra path)
  assert.equal(without.filter((i) => i.type === 'dispense').length, 0, 'no dispense events without includePharmacy (non-Ultra byte-for-byte)');
  const withPh = await timelineService.getTimeline(ctxA, patient._id, { includePharmacy: true });
  assert.equal(withPh.filter((i) => i.type === 'dispense').length, 1, 'dispense event present for Ultra clinics');
  // The rest of the timeline must be identical between the two calls (prescription event still there).
  assert.equal(without.length + 1, withPh.length, 'includePharmacy ADDS exactly the dispense event, nothing else changes');
  console.log('  ✓ (5e) timeline dispense events are feature-gated — non-Ultra timeline is unchanged');
});

test('(5f) dispensing routes are gated (requireFeature units) for non-Ultra tiers', () => {
  const { requireFeature } = require('../src/middleware/requireFeature');
  const check = (feature, plan) => {
    const guard = requireFeature(feature);
    let status = null; let next = false;
    guard({ clinic: { subscriptionPlan: plan } }, { status(c) { status = c; return this; }, json() { return this; } }, () => { next = true; });
    return next ? 'pass' : status;
  };
  for (const feature of ['MEDICINE_DISPENSING', 'DOSAGE_MANAGEMENT']) {
    for (const plan of ['basic', 'standard', 'premium']) assert.equal(check(feature, plan), 403, `${feature} must 403 for ${plan}`);
    assert.equal(check(feature, 'ultra_premium'), 'pass');
  }
  console.log('  ✓ (5f) MEDICINE_DISPENSING + DOSAGE_MANAGEMENT 403 for non-Ultra, pass for Ultra');
});

test('(5g) dispense is idempotent by clientToken — a retry never double-deducts or double-bills', async () => {
  const { rx, med } = await seedRxAndStock(ctxA, { name: 'Idem', batches: [{ batchNo: 'B', expiryDate: '2035-01-01', qty: 20 }] });
  const token = 'tok-abc-123';
  const first = await dispenseService.dispense(ctxA, { prescriptionId: rx._id, clientToken: token, items: [{ medicineId: med._id, qty: 5, unitPrice: 10 }] });
  const second = await dispenseService.dispense(ctxA, { prescriptionId: rx._id, clientToken: token, items: [{ medicineId: med._id, qty: 5, unitPrice: 10 }] });
  assert.equal(String(first._id), String(second._id), 'same token returns the same dispense (no-op)');
  assert.equal((await medicineService.get(ctxA, med._id)).available, 15, 'stock deducted only ONCE (20 − 5)');
  assert.equal((await Dispense.find({ clinicId: ctxA.clinicId }).lean()).length, 1, 'exactly one dispense record');
  assert.equal((await Invoice.find({ clinicId: ctxA.clinicId }).lean()).length, 1, 'exactly one invoice');
  // A NEW token dispenses again (legitimate second dispense / refill).
  await dispenseService.dispense(ctxA, { prescriptionId: rx._id, clientToken: 'tok-different', items: [{ medicineId: med._id, qty: 3, unitPrice: 10 }] });
  assert.equal((await medicineService.get(ctxA, med._id)).available, 12, 'a fresh token dispenses again');
  console.log('  ✓ (5g) same clientToken → idempotent no-op; a new token dispenses again');
});

/* ===================== Part 6 — UP-D storefront ==================== */

// ctxA is the Ultra clinic (org_ultraA). Add a Premium clinic to prove non-Ultra has no store.
const ctxP = { clinicId: 'org_premium', actorId: 'user_p1', actorRole: 'owner' };
async function seedClinics() {
  // website.published:true so getPublicSite serves the site (an unpublished site returns available:false).
  await Clinic.create({ clinicId: ctxA.clinicId, name: 'Ultra Clinic A', slug: 'ultra-a', subscriptionPlan: 'ultra_premium', website: { published: true } });
  await Clinic.create({ clinicId: ctxP.clinicId, name: 'Premium Clinic P', slug: 'prem-p', subscriptionPlan: 'premium', website: { published: true } });
}
async function makeStorePatient(ctx, email = 'buyer@example.com') {
  const p = await tenantRepo(Patient, ctx).create({ name: 'Buyer', patientCode: `SP-${email}`, email });
  return { patientId: String(p._id), email, clinicId: ctx.clinicId };
}
const FAKE_RX = { buffer: Buffer.from('rximage'), originalname: 'rx.jpg', mimetype: 'image/jpeg', size: 7 };

test('(6a) public store is Ultra-404-gated and tenant-isolated', async () => {
  await seedClinics();
  await medicineService.create(ctxA, { name: 'Cough Syrup A', sellingPrice: 50, gstRate: 5, symptomTags: ['cough'] });
  await medicineService.create(ctxP, { name: 'Premium-only Med', sellingPrice: 50 });
  // Non-Ultra clinic: the store simply does not exist (404 hide).
  await assert.rejects(() => storeService.home('prem-p'), /not available/i, 'non-Ultra store is 404-hidden');
  // Ultra clinic: store resolves and shows only its OWN featured products.
  const home = await storeService.home('ultra-a');
  assert.equal(home.store.slug, 'ultra-a');
  assert.equal(home.featured.length, 1, 'clinic A store shows only clinic A products (no bleed)');
  assert.equal(home.featured[0].name, 'Cough Syrup A');
  console.log('  ✓ (6a) store 404-hidden for non-Ultra; Ultra store tenant-isolated');
});

test('(6b) buildSite exposes `store` flag: true for Ultra, false for non-Ultra (payload otherwise unchanged)', async () => {
  await seedClinics();
  const ultra = await websiteService.getPublicSite('ultra-a');
  const prem = await websiteService.getPublicSite('prem-p');
  assert.equal(ultra.available, true);
  assert.equal(ultra.site.store, true, 'Ultra site advertises the store');
  assert.equal(prem.site.store, false, 'non-Ultra site has store:false');
  // The flag is the ONLY store-related addition — all other site fields exist unchanged.
  assert.ok(prem.site.clinic && prem.site.template && prem.site.theme && prem.site.content, 'non-Ultra site payload otherwise intact');
  console.log('  ✓ (6b) store flag true/false by tier; non-Ultra site payload otherwise unchanged');
});

test('(6c) symptom browse surfaces OTC/wellness only — never Rx-by-symptom (§5.4)', async () => {
  await seedClinics();
  await medicineService.create(ctxA, { name: 'Vitamin C (OTC)', sellingPrice: 20, symptomTags: ['immunity'], scheduleClass: 'OTC' });
  await medicineService.create(ctxA, { name: 'Rx Antibiotic', sellingPrice: 40, symptomTags: ['immunity'], scheduleClass: 'H1' }); // Rx (forced prescriptionRequired)
  const res = await storeService.symptomItems('ultra-a', 'immunity');
  const names = res.items.map((i) => i.name);
  assert.ok(names.includes('Vitamin C (OTC)'), 'OTC medicine surfaced by symptom');
  assert.ok(!names.includes('Rx Antibiotic'), 'Rx medicine NEVER surfaced by symptom');
  console.log('  ✓ (6c) symptom browse is OTC-only; Rx-by-symptom never shown');
});

test('(6d) order creation makes a GST invoice and flags Rx correctly', async () => {
  await seedClinics();
  const otc = await medicineService.create(ctxA, { name: 'Paracetamol OTC', sellingPrice: 10, gstRate: 12 });
  await inventoryService.createBatch(ctxA, { medicineId: otc._id, expiryDate: '2035-01-01', quantityInStock: 100 });
  const patient = await makeStorePatient(ctxA);
  const order = await storeOrderService.createOrder(ctxA, patient, { items: [{ medicineId: otc._id, qty: 3 }] });
  assert.match(order.orderNumber, /^ORD\d{5}$/);
  assert.equal(order.requiresPrescription, false);
  assert.equal(order.verificationStatus, 'not_required');
  assert.equal(order.total, 33.6, '3×₹10 + 12% GST');
  const inv = await Invoice.findById((await MedicineOrder.findOne({ clinicId: ctxA.clinicId }).lean()).invoiceId).lean();
  assert.equal(inv.total, 33.6, 'GST invoice created and linked');
  console.log('  ✓ (6d) order → linked GST invoice; OTC order needs no prescription');
});

test('(6e) Rx enforcement — an Rx order cannot be fulfilled until the prescription is verified (§5.3 / §14)', async () => {
  await seedClinics();
  const rxMed = await medicineService.create(ctxA, { name: 'Rx Med', sellingPrice: 20, gstRate: 0, scheduleClass: 'H' });
  await inventoryService.createBatch(ctxA, { medicineId: rxMed._id, expiryDate: '2035-01-01', quantityInStock: 50 });
  const patient = await makeStorePatient(ctxA);
  const order = await storeOrderService.createOrder(ctxA, patient, { items: [{ medicineId: rxMed._id, qty: 2 }] });
  assert.equal(order.requiresPrescription, true);
  assert.equal(order.verificationStatus, 'pending');
  // Pay it (simulate a settled invoice) so the ONLY remaining blocker is the Rx.
  const orderDoc = await MedicineOrder.findOne({ clinicId: ctxA.clinicId }).lean();
  await invoiceService.recordPayment(ctxA, orderDoc.invoiceId, { amount: order.total, method: 'cash' });
  // Cannot fulfil an Rx order that isn't verified.
  await assert.rejects(() => storeOpsService.fulfill(ctxA, orderDoc._id), /prescription must be verified/i);
  // Cannot verify without an uploaded prescription.
  await assert.rejects(() => storeOpsService.verifyRx(ctxA, orderDoc._id), /no prescription/i);
  // Upload → verify → fulfil deducts stock.
  await storeOrderService.uploadPrescription(ctxA, patient, orderDoc._id, FAKE_RX);
  await storeOpsService.verifyRx(ctxA, orderDoc._id);
  const fulfilled = await storeOpsService.fulfill(ctxA, orderDoc._id);
  assert.equal(fulfilled.status, 'fulfilled');
  assert.equal((await medicineService.get(ctxA, rxMed._id)).available, 48, 'fulfilment deducted 2 units FEFO');
  console.log('  ✓ (6e) Rx order blocked until prescription uploaded + verified, then fulfils & deducts stock');
});

test('(6f) fulfilment requires payment', async () => {
  await seedClinics();
  const otc = await medicineService.create(ctxA, { name: 'ORS OTC', sellingPrice: 10 });
  await inventoryService.createBatch(ctxA, { medicineId: otc._id, expiryDate: '2035-01-01', quantityInStock: 20 });
  const patient = await makeStorePatient(ctxA);
  const order = await storeOrderService.createOrder(ctxA, patient, { items: [{ medicineId: otc._id, qty: 2 }] });
  const orderDoc = await MedicineOrder.findOne({ clinicId: ctxA.clinicId }).lean();
  await assert.rejects(() => storeOpsService.fulfill(ctxA, orderDoc._id), /not paid/i, 'unpaid order cannot be fulfilled');
  await invoiceService.recordPayment(ctxA, orderDoc.invoiceId, { amount: order.total, method: 'cash' });
  const ok = await storeOpsService.fulfill(ctxA, orderDoc._id);
  assert.equal(ok.status, 'fulfilled');
  console.log('  ✓ (6f) unpaid order blocked; fulfils once paid');
});

test('(6g) storefront routes are gated (requireFeature units) for non-Ultra tiers', () => {
  const { requireFeature } = require('../src/middleware/requireFeature');
  const guard = requireFeature('PHARMACY_STOREFRONT');
  const run = (plan) => { let s = null; let n = false; guard({ clinic: { subscriptionPlan: plan } }, { status(c) { s = c; return this; }, json() { return this; } }, () => { n = true; }); return n ? 'pass' : s; };
  for (const plan of ['basic', 'standard', 'premium']) assert.equal(run(plan), 403, `${plan} must 403`);
  assert.equal(run('ultra_premium'), 'pass');
  console.log('  ✓ (6g) PHARMACY_STOREFRONT 403 for non-Ultra, pass for Ultra');
});
