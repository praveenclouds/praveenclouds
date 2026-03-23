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

const MONGO_OPTS = {
  serverSelectionTimeoutMS: 5_000,   // fail fast if no server found within 5 s
  socketTimeoutMS:          45_000,  // abort stalled socket ops after 45 s
  heartbeatFrequencyMS:     10_000,  // check server health every 10 s
};

/**
 * Connect to MongoDB with exponential-backoff retry.
 * Retries up to MAX_RETRIES times before giving up and exiting.
 */
const MAX_RETRIES = 5;

async function connect(attempt = 1) {
  if (mongoose.connection.readyState >= 1) return; // already connected

  try {
    await mongoose.connect(MONGO_URI, MONGO_OPTS);
    console.log(`✅  MongoDB connected → ${MONGO_URI}`);
  } catch (err) {
    if (attempt >= MAX_RETRIES) {
      console.error(`❌  MongoDB connection failed after ${MAX_RETRIES} attempts:`, err.message);
      process.exit(1);
    }
    const delay = Math.min(1000 * 2 ** attempt, 30_000); // 2s, 4s, 8s … capped at 30 s
    console.warn(`⚠️  MongoDB connect attempt ${attempt} failed — retrying in ${delay / 1000}s…`);
    await new Promise(r => setTimeout(r, delay));
    return connect(attempt + 1);
  }
}

// Re-emit mongoose connection events so the rest of the app can react.
mongoose.connection.on('disconnected', () => console.warn('⚠️  [MongoDB] disconnected'));
mongoose.connection.on('reconnected',  () => console.log('✅  [MongoDB] reconnected'));
mongoose.connection.on('error',        (err) => console.error('❌  [MongoDB] error:', err.message));

/**
 * Gracefully close the connection.
 * Useful in scripts (seed, migrations), test teardown, and graceful shutdown.
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
const SupportMailTemplate = require('./models/SupportMailTemplate');
const SlackWorkflowImport = require('./models/SlackWorkflowImport');
const RolePermission      = require('./models/RolePermission');

module.exports = { connect, disconnect, User, Asset, Log, Software, AdminUser, IntegrationSettings, SCIMConfig, AppConnector, SupportRequest, SupportRequestType, SupportMailTemplate, SlackWorkflowImport, RolePermission };
