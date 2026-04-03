const mongoose = require('mongoose');

function normalizeLowerList(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean))];
}

const mailInvoiceRuleSchema = new mongoose.Schema({
  softwareId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Software',
    required: true,
    index: true,
  },
  softwareCsvId: { type: String, default: '', trim: true, uppercase: true },
  softwareName: { type: String, default: '', trim: true },
  enabled: { type: Boolean, default: true, index: true },

  senderDomains: { type: [String], default: [] },
  senderEmails: { type: [String], default: [] },
  subjectKeywords: { type: [String], default: [] },
  excludeKeywords: { type: [String], default: [] },
  filenamePatterns: { type: [String], default: [] },
  vendorKeywordsInDoc: { type: [String], default: [] },
  bodyKeywords: { type: [String], default: [] },

  priority: { type: Number, default: 100 },
  autoAttachThreshold: { type: Number, default: 80 },
  reviewThreshold: { type: Number, default: 50 },

  createdBy: { type: String, default: '', trim: true },
  updatedBy: { type: String, default: '', trim: true },
}, { timestamps: true });

mailInvoiceRuleSchema.pre('save', function preSaveNormalize() {
  this.senderDomains = normalizeLowerList(this.senderDomains);
  this.senderEmails = normalizeLowerList(this.senderEmails);
  this.subjectKeywords = normalizeLowerList(this.subjectKeywords);
  this.excludeKeywords = normalizeLowerList(this.excludeKeywords);
  this.filenamePatterns = normalizeLowerList(this.filenamePatterns);
  this.vendorKeywordsInDoc = normalizeLowerList(this.vendorKeywordsInDoc);
  this.bodyKeywords = normalizeLowerList(this.bodyKeywords);

  const toInt = (value, fallback) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(100, Math.round(n)));
  };

  this.priority = Number.isFinite(Number(this.priority)) ? Number(this.priority) : 100;
  this.autoAttachThreshold = toInt(this.autoAttachThreshold, 80);
  this.reviewThreshold = toInt(this.reviewThreshold, 50);

  if (this.reviewThreshold > this.autoAttachThreshold) {
    this.reviewThreshold = this.autoAttachThreshold;
  }
});

mailInvoiceRuleSchema.index({ enabled: 1, priority: -1 });
mailInvoiceRuleSchema.index({ senderDomains: 1 });
mailInvoiceRuleSchema.index({ softwareId: 1, enabled: 1 });

module.exports = mongoose.model('MailInvoiceRule', mailInvoiceRuleSchema);
