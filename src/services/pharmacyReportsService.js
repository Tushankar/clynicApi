'use strict';

const { Dispense, MedicineOrder, PharmacyExpense } = require('../models');
const inventoryService = require('./pharmacyInventoryService');

/**
 * Pharmacy analytics (Ultra Premium, §6.7 / UP-E). Revenue (counter dispenses + fulfilled store
 * orders), COGS from the recorded FEFO batch allocations (qty × the batch's purchaseUnitCost),
 * gross margin, expenses, stock valuation, top medicines, and a 6-month P&L-shaped trend.
 *
 * Aggregations $match clinicId + deletedAt:null explicitly (they bypass the tenant repo — that
 * match IS the isolation guarantee, same as invoiceService.dayRegister / analyticsService).
 * Financial reports are OWNER-level (route-gated to owner + pharmacy_owner per spec §3).
 */
const TZ = 'Asia/Kolkata';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function parseRange({ from, to } = {}) {
  // Invalid/garbage dates are treated as absent (default window) — never a 500 from toISOString.
  const valid = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
  const end = valid(to) || new Date();
  end.setHours(23, 59, 59, 999);
  const start = valid(from) || new Date(end.getTime() - 29 * 24 * 3600 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end };
}

function monthKeys(n, now = new Date()) {
  const keys = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return keys;
}

// Revenue + COGS + per-medicine rollup for one source collection over a date field/window.
// COGS = Σ allocation.qty × batch.purchaseUnitCost (the exact lots the sale drew from).
function salesPipeline(clinicId, dateField, start, end, extraMatch = {}) {
  return [
    { $match: { clinicId, deletedAt: null, [dateField]: { $gte: start, $lte: end }, ...extraMatch } },
    { $unwind: '$items' },
    {
      $lookup: {
        from: 'inventorybatches',
        localField: 'items.allocations.batchId',
        foreignField: '_id',
        as: 'allocBatches',
      },
    },
    {
      $project: {
        medicineId: '$items.medicineId',
        medicineName: '$items.medicineName',
        qty: '$items.qty',
        lineRevenue: { $multiply: ['$items.qty', { $ifNull: ['$items.unitPrice', 0] }] },
        lineCogs: {
          $sum: {
            $map: {
              input: { $ifNull: ['$items.allocations', []] },
              as: 'a',
              in: {
                $multiply: [
                  '$$a.qty',
                  {
                    $ifNull: [
                      {
                        $first: {
                          $map: {
                            input: { $filter: { input: '$allocBatches', as: 'b', cond: { $eq: ['$$b._id', '$$a.batchId'] } } },
                            as: 'm',
                            in: { $ifNull: ['$$m.purchaseUnitCost', 0] },
                          },
                        },
                      },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        },
      },
    },
    {
      $group: {
        _id: { medicineId: '$medicineId', name: '$medicineName' },
        qty: { $sum: '$qty' },
        revenue: { $sum: '$lineRevenue' },
        cogs: { $sum: '$lineCogs' },
      },
    },
  ];
}

function monthlyPipeline(clinicId, dateField, start, end, sumExpr, extraMatch = {}) {
  return [
    { $match: { clinicId, deletedAt: null, [dateField]: { $gte: start, $lte: end }, ...extraMatch } },
    { $group: { _id: { $dateToString: { format: '%Y-%m', date: `$${dateField}`, timezone: TZ } }, amount: { $sum: sumExpr } } },
  ];
}

async function overview(ctx, { from, to } = {}) {
  const clinicId = ctx.clinicId;
  const { start, end } = parseRange({ from, to });
  const now = new Date();
  const months = monthKeys(6, now);
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);

  const [
    dispenseSales, orderSales,
    expenseAgg,
    dispenseMonthly, orderMonthly, expenseMonthly,
    counts,
    todayAgg,
    stock,
  ] = await Promise.all([
    Dispense.aggregate(salesPipeline(clinicId, 'dispensedAt', start, end)),
    MedicineOrder.aggregate(salesPipeline(clinicId, 'fulfilledAt', start, end, { status: 'fulfilled' })),
    PharmacyExpense.aggregate([
      { $match: { clinicId, deletedAt: null, date: { $gte: start, $lte: end } } },
      { $group: { _id: '$type', amount: { $sum: '$amount' } } },
    ]),
    // The trend is ALWAYS the 6 calendar months ending now — decoupled from the ad-hoc from/to range
    // (window: monthStart..now). Capping it at the range end would render months after `to` as fake zeros.
    Dispense.aggregate(monthlyPipeline(clinicId, 'dispensedAt', monthStart, now, '$total')),
    // Orders use SUBTOTAL (ex-GST) so revenue is ex-GST for both channels — GST is pass-through,
    // and Dispense.total is already ex-GST (Σ qty × unitPrice).
    MedicineOrder.aggregate(monthlyPipeline(clinicId, 'fulfilledAt', monthStart, now, '$subtotal', { status: 'fulfilled' })),
    PharmacyExpense.aggregate(monthlyPipeline(clinicId, 'date', monthStart, now, '$amount')),
    Promise.all([
      Dispense.countDocuments({ clinicId, deletedAt: null, dispensedAt: { $gte: start, $lte: end } }),
      MedicineOrder.countDocuments({ clinicId, deletedAt: null, status: 'fulfilled', fulfilledAt: { $gte: start, $lte: end } }),
      MedicineOrder.countDocuments({ clinicId, deletedAt: null, status: 'pending' }),
      MedicineOrder.countDocuments({ clinicId, deletedAt: null, requiresPrescription: true, verificationStatus: 'pending' }),
    ]),
    Promise.all([
      Dispense.aggregate([
        { $match: { clinicId, deletedAt: null, dispensedAt: { $gte: todayStart, $lte: now } } },
        { $group: { _id: null, amount: { $sum: '$total' }, count: { $sum: 1 } } },
      ]),
      MedicineOrder.aggregate([
        { $match: { clinicId, deletedAt: null, status: 'fulfilled', fulfilledAt: { $gte: todayStart, $lte: now } } },
        { $group: { _id: null, amount: { $sum: '$subtotal' }, count: { $sum: 1 } } }, // ex-GST, like dispenses
      ]),
    ]),
    inventoryService.summary(ctx),
  ]);

  // Merge per-medicine rollups from both channels.
  const byMed = new Map();
  for (const row of [...dispenseSales, ...orderSales]) {
    const key = String(row._id.medicineId);
    const cur = byMed.get(key) || { medicineId: key, name: row._id.name || '—', qty: 0, revenue: 0, cogs: 0 };
    cur.qty += row.qty || 0;
    cur.revenue = round2(cur.revenue + (row.revenue || 0));
    cur.cogs = round2(cur.cogs + (row.cogs || 0));
    byMed.set(key, cur);
  }
  const perMed = [...byMed.values()];
  const revenue = round2(perMed.reduce((s, m) => s + m.revenue, 0));
  const cogs = round2(perMed.reduce((s, m) => s + m.cogs, 0));
  const grossMargin = round2(revenue - cogs);
  const topMedicines = perMed
    .map((m) => ({ ...m, margin: round2(m.revenue - m.cogs) }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  const expenses = { purchases: 0, other: 0 };
  for (const g of expenseAgg) {
    if (g._id === 'purchase') expenses.purchases = round2(g.amount);
    else expenses.other = round2(expenses.other + g.amount);
  }
  // Operating view: gross margin (sales − cost of goods sold) minus non-stock running costs.
  // Stock purchases are cash-flow, not P&L cost (their cost hits COGS when the goods sell).
  const net = round2(grossMargin - expenses.other);

  const byMonth = (agg) => {
    const map = new Map((agg || []).map((m) => [m._id, m.amount || 0]));
    return months.map((m) => map.get(m) || 0);
  };
  const revD = byMonth(dispenseMonthly);
  const revO = byMonth(orderMonthly);
  const expM = byMonth(expenseMonthly);
  // Same {month, revenue, expenses, net} shape as the clinic P&L (cash view) so the UI reuses it.
  const trend = months.map((m, i) => ({
    month: m,
    revenue: round2(revD[i] + revO[i]),
    expenses: round2(expM[i]),
    net: round2(revD[i] + revO[i] - expM[i]),
  }));

  const [dispenseCount, fulfilledOrders, pendingOrders, rxAwaitingVerification] = counts;
  const [todayDisp, todayOrd] = todayAgg;

  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    sales: {
      revenue,
      cogs,
      grossMargin,
      marginPct: revenue > 0 ? round2((grossMargin / revenue) * 100) : 0,
      dispenses: dispenseCount,
      fulfilledOrders,
      today: round2((todayDisp[0]?.amount || 0) + (todayOrd[0]?.amount || 0)),
      todayCount: (todayDisp[0]?.count || 0) + (todayOrd[0]?.count || 0),
    },
    expenses: { ...expenses, total: round2(expenses.purchases + expenses.other) },
    net,
    stock, // { totalMedicines, totalBatches, stockValue, lowStockCount, expiringBatches, expiredBatches, nearExpiryDays }
    ordersQueue: { pending: pendingOrders, rxAwaitingVerification },
    topMedicines,
    trend,
    generatedAt: now.toISOString(),
  };
}

module.exports = { overview };
