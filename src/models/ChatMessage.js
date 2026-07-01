'use strict';

const mongoose = require('mongoose');
const { clinicScoped, branchAware } = require('./plugins');

/**
 * chatMessages — internal reception↔doctor messaging (§5.16 / 6).
 * Tenant-isolated + branch-aware; high-frequency, so not audited.
 * fromStaffId / toStaffId are Clerk user ids.
 */
const chatMessageSchema = new mongoose.Schema(
  {
    fromStaffId: { type: String, required: true },
    fromName: { type: String, trim: true },
    toStaffId: { type: String, required: true },
    body: { type: String, required: true, trim: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

clinicScoped(chatMessageSchema);
branchAware(chatMessageSchema);
// Conversation lookups in both directions.
chatMessageSchema.index({ clinicId: 1, fromStaffId: 1, toStaffId: 1, createdAt: 1 });
chatMessageSchema.index({ clinicId: 1, toStaffId: 1, read: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
