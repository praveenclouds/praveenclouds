const mongoose = require('mongoose');

const ASSET_DEPARTMENTS = [
  'Engineering',
  'Data Science - Engineering',
  'Data Science',
  'AI Services',
  'AI-Service',
  'QA',
  'IT',
  'HR',
  'Human Resources',
  'Product',
  'Customer Support',
  'Customer Operations',
  'Accounts',
  'Accounting / Finance',
  'Sales',
  'Marketing',
  'Legal',
  'Executive',
  'Executive Administration',
  'Operations',
  'Finance',
  'Other',
];

const assetSchema = new mongoose.Schema(
  {
    csvId: {
      type: String,
      unique: true,
      required: [true, 'Asset ID (e.g. A-01) is required'],
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: [true, 'Asset name is required'],
      trim: true,
    },
    type: {
      type: String,
      enum: ['Laptop', 'Monitor', 'Phone', 'Tablet', 'Keyboard', 'Mouse', 'Headset', 'Other'],
      required: true,
    },
    serial: {
      type: String,
      default: '',
      trim: true,
    },
    brand: {
      type: String,
      default: '',
      trim: true,
      comment: 'e.g. Apple / M2 Pro',
    },
    desc: {
      type: String,
      default: '',
      trim: true,
      comment: 'Specification, e.g. 16GB RAM - 512GB SSD M2-PRO',
    },
    status: {
      type: String,
      enum: ['Available', 'In-Use', 'Under Repair', 'Retired'],
      default: 'Available',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    location: {
      type: String,
      enum: ['Chennai', 'Coimbatore', 'USA', 'Canada'],
      required: true,
    },
    dept: {
      type: String,
      enum: ASSET_DEPARTMENTS,
      default: null,
    },
    vendor: {
      type: String,
      default: '',
      trim: true,
    },
    purchaseDate: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Purchase date must be in YYYY-MM-DD format'],
    },
    warrantyEnd: {
      type: String,
      default: null,
      match: [/^\d{4}-\d{2}-\d{2}$/, 'Warranty end date must be in YYYY-MM-DD format'],
    },
    notes: {
      type: String,
      default: '',
      trim: true,
      comment: 'Service history / repair notes',
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual: assigned user details (populated on demand)
assetSchema.virtual('assignedUser', {
  ref: 'User',
  localField: 'assignedTo',
  foreignField: '_id',
  justOne: true,
});

// Indexes  (csvId unique index is declared on the field — not repeated here)
assetSchema.index({ status: 1 });
assetSchema.index({ type: 1 });
assetSchema.index({ dept: 1 });
assetSchema.index({ location: 1 });
assetSchema.index({ assignedTo: 1 });

module.exports = mongoose.model('Asset', assetSchema);
