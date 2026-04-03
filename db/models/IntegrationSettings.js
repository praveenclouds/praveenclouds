/**
 * db/models/IntegrationSettings.js
 * Stores OAuth / SSO integration configuration for Terzo Portal
 */

const mongoose = require('mongoose');

const IntegrationSettingsSchema = new mongoose.Schema({
  provider: { type: String, default: 'google', unique: true },
  enabled:        { type: Boolean, default: false },
  clientId:       { type: String,  default: '' },
  clientSecret:   { type: String,  default: '' },
  allowedDomain:  { type: String,  default: '' },  // e.g. "terzocloud.com"
  signingSecret:  { type: String,  default: '' },  // Slack request verification
  gmailMailbox:   { type: String,  default: '' },
  gmailRefreshToken: { type: String, default: '' },
  gmailQuery:     { type: String, default: '(invoice OR receipt OR "tax invoice" OR billing OR statement)' },
  gmailLastSyncedAt: { type: Date, default: null },
  gmailLastHistoryId: { type: String, default: '' },
  smtpHost:       { type: String,  default: '' },
  smtpPort:       { type: Number,  default: 587 },
  smtpSecure:     { type: Boolean, default: false },
  smtpUser:       { type: String,  default: '' },
  smtpPass:       { type: String,  default: '' },
  fromEmail:      { type: String,  default: '' },
  fromName:       { type: String,  default: 'Terzo Support' },
  appBaseUrl:     { type: String,  default: '' },
}, { timestamps: true });

module.exports = mongoose.model('IntegrationSettings', IntegrationSettingsSchema);
