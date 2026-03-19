/**
 * db/index.js
 * MongoDB connection helper for TerzoCloud – User & Asset Management Portal
 *
 * Usage:
 *   const { connect, disconnect } = require('./db');
 *   await connect();
 */

const mongoose = require('mongoose');
const { MONGO_URI } = require('../config');

/**
 * Connect to MongoDB.
 * Call this once at application startup.
 */
async function connect() {
  if (mongoose.connection.readyState >= 1) return; // already connected

  try {
    await mongoose.connect(MONGO_URI, {
      // Mongoose 7+ ignores deprecated options; kept here for clarity
    });
    console.log(`✅  MongoDB connected → ${MONGO_URI}`);
  } catch (err) {
    console.error('❌  MongoDB connection error:', err.message);
    process.exit(1);
  }
}

/**
 * Gracefully close the connection.
 * Useful in scripts (seed, migrations) and test teardown.
 */
async function disconnect() {
  await mongoose.disconnect();
  console.log('🔌  MongoDB disconnected');
}

// Re-export models so callers can do:
//   const { User, Asset } = require('./db');
const User                = require('./models/User');
const Asset               = require('./models/Asset');
const Log                 = require('./models/Log');
const Software            = require('./models/Software');
const AdminUser           = require('./models/AdminUser');
const IntegrationSettings = require('./models/IntegrationSettings');
const SCIMConfig          = require('./models/SCIMConfig');
const AppConnector        = require('./models/AppConnector');
const SupportRequest      = require('./models/SupportRequest');
const SupportRequestType  = require('./models/SupportRequestType');
const SlackWorkflowImport = require('./models/SlackWorkflowImport');
const RolePermission      = require('./models/RolePermission');

module.exports = { connect, disconnect, User, Asset, Log, Software, AdminUser, IntegrationSettings, SCIMConfig, AppConnector, SupportRequest, SupportRequestType, SlackWorkflowImport, RolePermission };
