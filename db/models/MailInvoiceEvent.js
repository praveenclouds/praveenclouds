const mongoose = require('mongoose');

const STATUSES = [
  'queued',
  'downloaded',
  'matched',
  'review_required',
  'attached',
  'parsed',
  'failed',
  'ignored',
];

const mailInvoiceEventSchema = new mongoose.Schema({
  provider: { type: String, enum: ['gmail'], default: 'gmail', index: true },
  mailbox: { type: String, default: '', trim: true, lowercase: true },

  messageId: { type: String, required: true, trim: true },
  threadId: { type: String, default: '', trim: true },
  historyId: { type: String, default: '', trim: true },

  from: { type: String, default: '', trim: true },
  fromEmail: { type: String, default: '', trim: true, lowercase: true },
  fromDomain: { type: String, default: '', trim: true, lowercase: true },
  subject: { type: String, default: '', trim: true },
  receivedAt: { type: Date, default: null },

  attachmentName: { type: String, default: '', trim: true },
  attachmentMime: { type: String, default: '', trim: true },
  attachmentSize: { type: Number, default: 0 },
  attachmentHashSha256: { type: String, default: '', trim: true },
  gmailAttachmentId: { type: String, default: '', trim: true },
  invoiceLinks: { type: [String], default: [] },
  preferredInvoiceUrl: { type: String, default: '', trim: true },

  matchedSoftwareId: { type: mongoose.Schema.Types.ObjectId, ref: 'Software', default: null, index: true },
  matchedRuleId: { type: mongoose.Schema.Types.ObjectId, ref: 'MailInvoiceRule', default: null },
  matchScore: { type: Number, default: 0 },
  matchReasons: { type: [String], default: [] },

  status: { type: String, enum: STATUSES, default: 'queued', index: true },
  reviewRequired: { type: Boolean, default: true, index: true },
  error: { type: String, default: '' },

  softwareInvoiceId: { type: mongoose.Schema.Types.ObjectId, default: null },

  storageProvider: { type: String, default: '', trim: true },
  storageKey: { type: String, default: '', trim: true },

  extraction: {
    amount: { type: Number, default: null },
    currency: { type: String, default: '', trim: true },
    billingPeriod: { type: String, default: '', trim: true },
    periodFrom: { type: Date, default: null },
    periodTo: { type: Date, default: null },
    licenseQuantity: { type: Number, default: null },
    licenseUnitPrice: { type: Number, default: null },
    subscriptionPlan: { type: String, default: '', trim: true },
    parseConfidence: { type: String, default: '', trim: true },
    source: { type: String, default: '', trim: true },
    warnings: { type: [String], default: [] },
    needsReview: { type: Boolean, default: true },
  },
}, { timestamps: true });

mailInvoiceEventSchema.index({ provider: 1, messageId: 1, attachmentHashSha256: 1 }, { unique: true });
mailInvoiceEventSchema.index({ status: 1, reviewRequired: 1, createdAt: -1 });
mailInvoiceEventSchema.index({ mailbox: 1, createdAt: -1 });

module.exports = mongoose.model('MailInvoiceEvent', mailInvoiceEventSchema);
