const mongoose = require('mongoose');

const mailInvoiceBlobSchema = new mongoose.Schema({
  eventId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MailInvoiceEvent',
    required: true,
    index: true,
    unique: true,
  },
  provider: { type: String, enum: ['gmail'], default: 'gmail', index: true },
  messageId: { type: String, default: '', trim: true, index: true },
  attachmentHashSha256: { type: String, default: '', trim: true, index: true },
  filename: { type: String, default: '', trim: true },
  mimeType: { type: String, default: 'application/pdf', trim: true },
  size: { type: Number, default: 0 },
  data: { type: Buffer, required: true },
}, { timestamps: true });

mailInvoiceBlobSchema.index({ provider: 1, messageId: 1, attachmentHashSha256: 1 });

module.exports = mongoose.model('MailInvoiceBlob', mailInvoiceBlobSchema);
