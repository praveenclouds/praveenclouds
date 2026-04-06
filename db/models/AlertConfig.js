const mongoose = require('mongoose');

const alertConfigSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'default',
      unique: true,
      trim: true,
      maxlength: 64,
    },
    inventory: {
      users: { type: Boolean, default: true },
      software: { type: Boolean, default: true },
      assets: { type: Boolean, default: true },
    },
    notifications: {
      inApp: { type: Boolean, default: true },
      slack: { type: Boolean, default: false },
      email: { type: Boolean, default: false },
    },
    updatedBy: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
    createdBy: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AlertConfig', alertConfigSchema);
