/**
 * services/log.service.js — Audit log helpers
 *
 * Wraps the Log model so route handlers stay clean.
 * All writes go through writeLog(); failures are silently logged to console
 * so they never interrupt the main request flow.
 */
const { Log } = require('../db');
const { ACTOR } = require('../config');

/**
 * Write an audit log entry.
 * @param {object} data  — any fields accepted by the Log schema
 */
async function writeLog(data) {
  try {
    const payload = { ...data };
    if (!payload.actorName) payload.actorName = ACTOR;
    await Log.create(payload);
  } catch (err) {
    console.error('[LOG] write error:', err.message);
  }
}

module.exports = { writeLog };
