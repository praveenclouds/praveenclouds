const mongoose = require('mongoose');

const alertRuleSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Alert name is required'],
      trim: true,
      minlength: 2,
      maxlength: 180,
    },
    category: {
      type: String,
      enum: ['users', 'software', 'assets'],
      required: [true, 'Alert category is required'],
    },
    condition: {
      type: String,
      required: [true, 'Alert condition is required'],
      trim: true,
      maxlength: 120,
    },
    threshold: {
      type: Number,
      default: null,
    },
    description: {
      type: String,
      default: '',
      trim: true,
      maxlength: 500,
    },
    channels: {
      type: [String],
      default: ['inApp'],
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    createdBy: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
    updatedBy: {
      type: String,
      default: '',
      trim: true,
      maxlength: 160,
    },
  },
  { timestamps: true }
);

alertRuleSchema.index({ category: 1, enabled: 1 });

module.exports = mongoose.model('AlertRule', alertRuleSchema);

