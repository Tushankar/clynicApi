'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * pharmacyExpenses — the pharmacy's outgoings (Ultra Premium, §6.7 / §7). SEPARATE from the main
 * app's `Expense` collection so pharmacy financials never pollute the clinic's existing P&L; the
 * pharmacy-specific P&L/analytics (UP-E) reads this. `purchase` rows are auto-created when a
 * purchase order is received (GRN); `other` rows are manual. Money record → soft-deletable + audited.
 */
const EXPENSE_TYPES = ['purchase', 'other'];
const OTHER_CATEGORIES = ['rent', 'salaries', 'utilities', 'transport', 'equipment', 'licenses', 'other'];

const pharmacyExpenseSchema = new mongoose.Schema(
  {
    type: { type: String, enum: EXPENSE_TYPES, default: 'other' },
    amount: { type: Number, required: true, min: 0 },
    category: { type: String, trim: true, maxlength: 60 }, // for 'other' expenses
    relatedPurchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseOrder', default: null },
    supplierId: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    note: { type: String, trim: true, maxlength: 500 },
    date: { type: Date, required: true },
    createdBy: { type: String, default: null }, // Clerk user id
  },
  { timestamps: true }
);

clinicScoped(pharmacyExpenseSchema);
branchAware(pharmacyExpenseSchema);
softDeletable(pharmacyExpenseSchema);
pharmacyExpenseSchema.index({ clinicId: 1, date: -1 });
pharmacyExpenseSchema.index({ clinicId: 1, type: 1, date: -1 });

pharmacyExpenseSchema.statics.TYPES = EXPENSE_TYPES;
pharmacyExpenseSchema.statics.OTHER_CATEGORIES = OTHER_CATEGORIES;

module.exports = mongoose.model('PharmacyExpense', pharmacyExpenseSchema);
