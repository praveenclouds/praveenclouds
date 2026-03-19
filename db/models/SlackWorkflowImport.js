const mongoose = require('mongoose');

const SlackWorkflowSchema = new mongoose.Schema({
  key:          { type: String, required: true },
  title:        { type: String, default: '' },
  description:  { type: String, default: '' },
  callbackId:   { type: String, default: '' },
  triggerTypes: [{ type: String }],
  stepCount:    { type: Number, default: 0 },
  steps:        [{ type: mongoose.Schema.Types.Mixed }],
  raw:          { type: mongoose.Schema.Types.Mixed, default: {} },
}, { _id: false });

const SlackWorkflowImportSchema = new mongoose.Schema({
  sourceType: {
    type: String,
    enum: ['slack_manifest_export', 'manifest_json'],
    required: true,
  },
  sourceAppId:   { type: String, required: true, unique: true, index: true },
  sourceAppName: { type: String, default: '' },
  manifestVersion: { type: String, default: '' },
  workflowCount: { type: Number, default: 0 },
  workflows:     { type: [SlackWorkflowSchema], default: [] },
  importedAt:    { type: Date, default: Date.now },
  importedBy: {
    id:    { type: String, default: '' },
    name:  { type: String, default: '' },
    email: { type: String, default: '' },
  },
}, { timestamps: true });

module.exports = mongoose.model('SlackWorkflowImport', SlackWorkflowImportSchema);
