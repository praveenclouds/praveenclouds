const mongoose = require('mongoose');

/**
 * Log.js — Activity log for device allocations & user info modifications
 *
 * eventType categories:
 *   device_allocated   – asset assigned to a user
 *   device_unassigned  – asset unassigned from a user
 *   asset_created      – new asset added
 *   asset_updated      – asset details edited (non-allocation change)
 *   asset_deleted      – asset removed
 *   software_created   – new software added
 *   software_updated   – software details edited
 *   software_deleted   – software removed
 *   user_created       – new user added
 *   user_updated       – user info modified
 *   user_deleted       – user removed
 */

const changeSchema = new mongoose.Schema(
  {
    field:    { type: String, required: true },
    oldValue: { type: String, default: '—' },
    newValue: { type: String, default: '—' },
  },
  { _id: false }
);

const logSchema = new mongoose.Schema(
  {
    // What happened
    eventType: {
      type: String,
      required: true,
      enum: [
        'device_allocated',
        'device_unassigned',
        'asset_created',
        'asset_updated',
        'asset_deleted',
        'software_created',
        'software_updated',
        'software_deleted',
        'user_created',
        'user_updated',
        'user_deleted',
      ],
    },

    // The record that was affected
    entityType: { type: String, enum: ['user', 'asset', 'software'], required: true },
    entityId:   { type: String, required: true },
    entityLabel:{ type: String, default: '' },   // e.g. "Macbook Pro 15 (A-42)"

    // For device-allocation events — full snapshot
    deviceId:   { type: String, default: '' },   // csvId, e.g. A-42
    deviceType: { type: String, default: '' },   // Laptop / Phone …
    deviceModel:{ type: String, default: '' },   // e.g. Macbook Pro 15
    deviceSerial:{ type: String, default: '' },

    // Assigned user context (for allocation events)
    assignedUserId:  { type: String, default: '' },
    assignedUserName:{ type: String, default: '' },
    assignedUserDept:{ type: String, default: '' },

    // For user-modification events — field-level diff
    changes: { type: [changeSchema], default: [] },

    // Remarks / reason (optional; client may pass)
    remarks: { type: String, default: '' },

    // Who performed the action
    actorName: { type: String, default: 'Praveen M. (IT Admin)' },

    // Human-readable one-liner (generated server-side)
    summary: { type: String, default: '' },
  },
  {
    timestamps: true,   // createdAt = event timestamp
  }
);

logSchema.index({ eventType: 1 });
logSchema.index({ entityType: 1 });
logSchema.index({ entityId: 1 });
logSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Log', logSchema);
