const mongoose = require('mongoose');

const departmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Department name is required'],
      trim: true,
      minlength: 2,
      maxlength: 120,
      unique: true,
    },
    isActive: {
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

departmentSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('Department', departmentSchema);

