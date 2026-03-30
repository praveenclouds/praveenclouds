/**
 * routes/users.routes.js — User management + app access
 *
 * GET    /api/users
 * POST   /api/users
 * PUT    /api/users/:id
 * DELETE /api/users/:id
 * PUT    /api/users/:id/app-access
 */
const router = require('express').Router();
const { User, Asset, Software, AppConnector } = require('../db');
const { requireAuth, canWriteUsers } = require('../middleware/auth');
const { fmt, diffObjects } = require('../utils/format');
const { writeLog } = require('../services/log.service');
const { sendAppInvite } = require('../services/connector.service');
const crypto = require('crypto');
const _EK = process.env.ENCRYPT_KEY || process.env.JWT_SECRET || 'terzo_encrypt_fallback_dev';
function _dk(s) { return crypto.createHash('sha256').update(s).digest(); }
function _decryptToken(v) {
  if (!v || !v.startsWith('enc:')) return v;
  try { const [,iv,enc]=v.split(':'); const d=crypto.createDecipheriv('aes-256-cbc',_dk(_EK),Buffer.from(iv,'hex')); return d.update(enc,'hex','utf8')+d.final('utf8'); } catch { return v; }
}

const TRACKED_FIELDS = [
  'first', 'last', 'email', 'dept', 'role', 'location', 'status',
  'jobTitle', 'reportingManager', 'phone', 'employmentType', 'lastWorkingDate',
];

// ── GET /api/users ─────────────────────────────────────────────────────────────
// Supports optional ?page=1&limit=200&all=true query params.
// Defaults to returning all records (limit=0) to preserve existing UI behaviour,
// but callers can opt-in to pagination when needed.
router.get('/', requireAuth, async (req, res) => {
  try {
    const { status, all, includeInactive } = req.query;
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.max(0, parseInt(req.query.limit) || 0); // 0 = no limit (default)

    const filter = {};
    if (status) {
      filter.status = status;
    } else if (!['1', 'true', 'yes'].includes(String(includeInactive || '').trim().toLowerCase())) {
      filter.status = 'Active';
    }

    const query = User.find(filter).sort({ first: 1 });
    if (limit > 0 && !all) {
      const total = await User.countDocuments(filter);
      const users = await query.skip((page - 1) * limit).limit(limit);
      return res.json({ total, page, limit, users: users.map(fmt) });
    }
    // No pagination requested — return flat array (backward-compatible)
    const users = await query;
    res.json(users.map(fmt));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/users ────────────────────────────────────────────────────────────
router.post('/', requireAuth, canWriteUsers, async (req, res) => {
  try {
    // Whitelist allowed fields to prevent mass assignment
    const ALLOWED_CREATE_FIELDS = ['first', 'last', 'email', 'dept', 'role', 'location', 'status',
      'jobTitle', 'reportingManager', 'phone', 'employmentType', 'lastWorkingDate'];
    const sanitized = {};
    ALLOWED_CREATE_FIELDS.forEach(k => { if (req.body[k] !== undefined) sanitized[k] = req.body[k]; });
    const user = await User.create(sanitized);
    const u    = fmt(user);
    await writeLog({
      eventType:   'user_created',
      entityType:  'user',
      entityId:    u.id,
      entityLabel: `${u.first} ${u.last}`.trim(),
      summary:     `New user created: ${u.first} ${u.last} (${u.dept}, ${u.email})`,
    });
    res.status(201).json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/users/:id ─────────────────────────────────────────────────────────
router.put('/:id', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const oldUser = await User.findById(req.params.id).lean();
    // Whitelist allowed fields to prevent mass assignment
    const ALLOWED_USER_FIELDS = ['first', 'last', 'email', 'dept', 'role', 'location', 'status',
      'jobTitle', 'reportingManager', 'phone', 'employmentType', 'lastWorkingDate'];
    const sanitized = {};
    ALLOWED_USER_FIELDS.forEach(k => { if (req.body[k] !== undefined) sanitized[k] = req.body[k]; });
    const user    = await User.findByIdAndUpdate(req.params.id, sanitized, {
      new: true, runValidators: true,
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const u = fmt(user);

    const changes = diffObjects(oldUser || {}, req.body, TRACKED_FIELDS);
    if (changes.length > 0) {
      await writeLog({
        eventType:   'user_updated',
        entityType:  'user',
        entityId:    u.id,
        entityLabel: `${u.first} ${u.last}`.trim(),
        changes,
        summary:     `User info updated: ${u.first} ${u.last} — ${changes.map(c => c.field).join(', ')} changed`,
      });
    }
    res.json(u);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /api/users/:id ──────────────────────────────────────────────────────
router.delete('/:id', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Release assigned assets
    await Asset.updateMany(
      { assignedTo: req.params.id },
      { $set: { assignedTo: null, status: 'Available' } }
    );
    await writeLog({
      eventType:   'user_deleted',
      entityType:  'user',
      entityId:    req.params.id,
      entityLabel: `${user.first} ${user.last}`.trim(),
      summary:     `User deleted: ${user.first} ${user.last} (${user.dept}, ${user.email})`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/users/:id/app-access ─────────────────────────────────────────────
// Body: { appAccess: ['A-01', 'A-11', ...], appRoles: { 'A-01': 'Admin' } }
router.put('/:id/app-access', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const { appAccess, appRoles } = req.body;
    if (!Array.isArray(appAccess))
      return res.status(400).json({ error: 'appAccess must be an array of software IDs' });

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const oldAccess  = Array.isArray(user.appAccess) ? user.appAccess : [];
    const newlyAdded = appAccess.filter(id => !oldAccess.includes(id));

    user.appAccess = appAccess;
    if (appRoles && typeof appRoles === 'object') {
      user.appRoles = appRoles;
      user.markModified('appRoles');
    }
    await user.save();

    // Fire invites for newly added apps
    const inviteResults = [];
    for (const csvId of newlyAdded) {
      const software  = await Software.findOne({ csvId }).lean();
      if (!software) {
        inviteResults.push({ csvId, appName: csvId, status: 'no_software', message: 'Software record not found' });
        continue;
      }
      const connector = await AppConnector.findOne({ softwareCsvId: csvId, enabled: true }).lean();
      if (!connector) {
        inviteResults.push({ csvId, appName: software.name, status: 'no_connector', message: 'No active connector configured for this app' });
        continue;
      }
      // Decrypt token if encrypted
      const connDecrypted = { ...connector, apiToken: _decryptToken(connector.apiToken) };
      const result = await sendAppInvite(connDecrypted, user);
      inviteResults.push({ csvId, appName: software.name, ...result });
    }

    if (newlyAdded.length > 0) {
      const names    = await Software.find({ csvId: { $in: newlyAdded } }).select('name').lean();
      const nameList = names.map(s => s.name).join(', ');
      await writeLog({
        eventType:   'user_updated',
        entityType:  'user',
        entityId:    user._id.toString(),
        entityLabel: `${user.first} ${user.last}`.trim(),
        summary:     `App access granted: ${nameList} → ${user.first} ${user.last}`,
      });
    }

    res.json({ ok: true, appAccess: user.appAccess, inviteResults });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
