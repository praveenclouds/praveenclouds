/**
 * config.js — Central configuration constants
 * All environment variables and shared settings live here.
 * Import this instead of reading process.env directly in route files.
 */
require('dotenv').config();

const IS_PROD = process.env.NODE_ENV === 'production';

// ── Hard fail in production if critical secrets are missing ───────────────────
if (IS_PROD && !process.env.JWT_SECRET) {
  console.error('❌  FATAL: JWT_SECRET environment variable is required in production.');
  console.error('    Set it with: export JWT_SECRET=<your-strong-random-secret>');
  process.exit(1);
}

module.exports = {
  IS_PROD,
  PORT:        process.env.PORT        || 3000,
  JWT_SECRET:  process.env.JWT_SECRET  || 'terzocloud_jwt_secret_2025_dev_only',
  JWT_EXPIRES: process.env.JWT_EXPIRES || '24h',
  MONGO_URI:   process.env.MONGO_URI   || process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/terzocloud_assets',
  ACTOR:       process.env.LOG_ACTOR   || 'Praveen M. (IT Admin)',
  // Allowed origins for CORS — comma-separated in env, e.g. https://portal.terzocloud.com
  CORS_ORIGINS: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(s => s.trim()) : null,
};
