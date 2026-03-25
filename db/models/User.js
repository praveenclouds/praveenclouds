const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    legacyId: {
      type: String,
      unique: true,
      sparse: true,
    },
    empId: {
      type: String,
      default: '',
      trim: true,
      comment: 'Employee ID from HR (e.g. E001)',
    },
    first: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
    },
    last: {
      type: String,
      default: '',
      trim: true,
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Please enter a valid email address'],
    },
    role: {
      type: String,
      enum: ['Admin', 'Manager', 'Staff'],
      default: 'Staff',
    },
    reportingManager: {
      type: String,
      default: '',
      trim: true,
    },
    status: {
      type: String,
      enum: ['Active', 'Inactive'],
      default: 'Active',
    },
    jobTitle: {
      type: String,
      default: '',
      trim: true,
    },
    dept: {
      type: String,
      default: '',
    },
    location: {
      type: String,
      enum: ['India', 'USA', 'Canada'],
      default: 'India',
    },
    employmentType: {
      type: String,
      enum: ['Full Time', 'Part Time', 'Contractor'],
      default: 'Full Time',
    },
    phone: {
      type: String,
      default: '',
      trim: true,
    },
    joined: {
      type: Date,
      default: Date.now,
    },
    scimExternalId: {
      type: String,
      default: '',
      trim: true,
      index: true,
      comment: 'Google Workspace immutable user ID, set by SCIM provisioner',
    },
    appAccess: {
      type: [String],
      default: [],
      comment: 'Array of Software csvIds this user has been granted access to',
    },
    appRoles: {
      type: Object,
      default: {},
      comment: 'Map of Software csvId → role (e.g. { "A-01": "Admin", "A-03": "Member" })',
    },
  },
  {
    timestamps: true, // adds createdAt & updatedAt
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual: full name
userSchema.virtual('fullName').get(function () {
  return `${this.first} ${this.last}`.trim();
});

// Virtual: assets currently assigned to this user
userSchema.virtual('assignedAssets', {
  ref: 'Asset',
  localField: '_id',
  foreignField: 'assignedTo',
});

// Indexes  (email unique index is declared on the field — not repeated here)
userSchema.index({ dept: 1 });
userSchema.index({ location: 1 });
userSchema.index({ status: 1 });
userSchema.index({ role: 1 });

module.exports = mongoose.model('User', userSchema);
