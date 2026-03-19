/**
 * db/models/IntegrationSettings.js
 * Stores OAuth / SSO integration configuration for TerzoCloud Portal
 */

const mongoose = require('mongoose');

const IntegrationSettingsSchema = new mongoose.Schema({
  provider: { type: String, default: 'google', unique: true },
  enabled:        { type: Boolean, default: false },
  clientId:       { type: String,  default: '' },
  clientSecret:   { type: String,  default: '' },
  allowedDomain:  { type: String,  default: '' },  // e.g. "terzocloud.com"
  signingSecret:  { type: String,  default: '' },  // Slack request verification
  smtpHost:       { type: String,  default: '' },
  smtpPort:       { type: Number,  default: 587 },
  smtpSecure:     { type: Boolean, default: false },
  smtpUser:       { type: String,  default: '' },
  smtpPass:       { type: String,  default: '' },
  fromEmail:      { type: String,  default: '' },
  fromName:       { type: String,  default: 'TerzoCloud Support' },
  appBaseUrl:     { type: String,  default: '' },
}, { timestamps: true });

module.exports = mongoose.model('IntegrationSettings', IntegrationSettingsSchema);
