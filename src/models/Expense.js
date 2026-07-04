'use strict';

const mongoose = require('mongoose');
const { clinicScoped, softDeletable, branchAware } = require('./plugins');

/**
 * expenses — clinic outgoings (§5.23, Premium): rent, salaries, supplies, lab fees…
 * Powers the P&L view in analytics (revenue − expenses). Financial record →
 * soft-deletable + audited via the tenant repo (hard rules 6, 7).
 */
const EXPENSE_CATEGORIES = ['rent', 'salaries', 'supplies', 'equipment', 'utilities', 'marketing', 'lab', 'maintenance', 'other'];

const expenseSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    category: { type: String, enum: EXPENSE_CATEGORIES, default: 'other' },
    description: { type: String, required: true, trim: true, maxlength: 200 },
    amount: { type: Number, required: true, min: 0 },
    method: { type: String, enum: ['cash', 'upi', 'card', 'bank', 'other'], default: 'cash' },
    note: { type: String, trim: true, maxlength: 500 },
    createdBy: { type: String, default: null },
  },
  { timestamps: true }
);

clinicScoped(expenseSchema);
branchAware(expenseSchema);
softDeletable(expenseSchema);
expenseSchema.index({ clinicId: 1, date: -1 });
expenseSchema.index({ clinicId: 1, category: 1, date: -1 });

expenseSchema.statics.CATEGORIES = EXPENSE_CATEGORIES;

module.exports = mongoose.model('Expense', expenseSchema);
