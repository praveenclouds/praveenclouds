const mongoose = require('mongoose');

// ── Service sub-document (add-on tiers within an app, e.g. Zoom Phone) ──────
const serviceSchema = new mongoose.Schema({
  name:     { type: String, required: true, trim: true },
  plan:     { type: String, default: '', trim: true },
  annualCost:               { type: Number, default: 0 },
  licensePricePerUserMonth: { type: Number, default: 0 },
  purchasedLicenses:        { type: Number, default: 0 },
  usedLicenses:             { type: Number, default: 0 },
  renewalPeriod:            { type: String, default: '' },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },
}, { _id: true });

const softwareSchema = new mongoose.Schema(
  {
    csvId: {
      type: String, unique: true, required: true, uppercase: true, trim: true,
    },
    name:       { type: String, required: true, trim: true },
    owner:      { type: String, default: '', trim: true },
    admins:     { type: String, default: '', trim: true },
    billedTo:   { type: String, default: '', trim: true },
    deploymentType: {
      type: String,
      enum: ['SAAS', 'On-premises', 'Freeware', 'Open Source'],
      default: 'SAAS',
    },
    provisioningMethod: {
      type: String,
      enum: ['SCIM', 'API', 'SSO Only', 'Manual'],
      default: 'Manual',
    },
    connectorType:    { type: String, default: '', trim: true },
    supportsDeprovision: { type: Boolean, default: false },
    provisioningNotes: { type: String, default: '', trim: true },
    department:       { type: String, default: '', trim: true },
    purpose:          { type: String, default: '', trim: true },
    subscriptionPlan: { type: String, default: '', trim: true },
    renewalPeriod: {
      type: String,
      enum: ['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''],
      default: '',
    },
    annualCost:             { type: Number, default: 0 },
    licensePricePerUserMonth: { type: Number, default: 0 },
    purchasedLicenses:      { type: Number, default: 0 },
    usedLicenses:           { type: Number, default: 0 },

    // Active sites
    siteUSA: { type: Boolean, default: false },
    siteCAN: { type: Boolean, default: false },
    siteIND: { type: Boolean, default: false },

    // Allocated cost per site (annual)
    costUSA: { type: Number, default: 0 },
    costCAN: { type: Number, default: 0 },
    costIND: { type: Number, default: 0 },

    status: { type: String, enum: ['Active', 'Inactive'], default: 'Active' },

    // Add-on services (e.g. Zoom → Zoom Phone, Zoom Rooms)
    services: { type: [serviceSchema], default: [] },
  },
  { timestamps: true }
);

softwareSchema.index({ deploymentType: 1 });
softwareSchema.index({ provisioningMethod: 1 });
softwareSchema.index({ department: 1 });
softwareSchema.index({ status: 1 });
softwareSchema.index({ annualCost: -1 });

module.exports = mongoose.model('Software', softwareSchema);
