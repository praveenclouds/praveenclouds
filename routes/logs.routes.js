/**
 * routes/logs.routes.js — Audit Logs
 *
 * GET /api/logs?type=&entityType=&search=&page=&limit=
 */
const router = require('express').Router();
const { Log }  = require('../db');
const { requireAuth, canViewActivityLog } = require('../middleware/auth');

// Escape special regex characters to prevent ReDoS from user-supplied search strings.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── DELETE /api/logs/asset/:deviceId ──────────────────────────────────────────
// Clears all history log entries for a specific asset (matched by deviceId / csvId).
const { canWriteAssets } = require('../middleware/auth');
router.delete('/asset/:deviceId', requireAuth, canWriteAssets, async (req, res) => {
  try {
    const { deviceId } = req.params;
    if (!deviceId) return res.status(400).json({ error: 'deviceId is required' });
    const result = await Log.deleteMany({ deviceId: deviceId.toUpperCase() });
    res.json({ ok: true, deleted: result.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/logs ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, canViewActivityLog, async (req, res) => {
  try {
    const { type, entityType, search, page = 1, limit = 25 } = req.query;

    const filter = {};
    if (type)       filter.eventType  = type;
    if (entityType) filter.entityType = entityType;
    if (search) {
      const re = new RegExp(escapeRegex(String(search).slice(0, 200)), 'i');
      filter.$or = [
        { summary:          re },
        { entityLabel:      re },
        { assignedUserName: re },
        { deviceId:         re },
        { actorName:        re },
      ];
    }

    const skip  = (parseInt(page) - 1) * parseInt(limit);
    const total = await Log.countDocuments(filter);
    const logs  = await Log.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const formatted = logs.map(l => ({
      id:               l._id.toString(),
      eventType:        l.eventType,
      entityType:       l.entityType,
      entityId:         l.entityId,
      entityLabel:      l.entityLabel,
      deviceId:         l.deviceId,
      deviceType:       l.deviceType,
      deviceModel:      l.deviceModel,
      deviceSerial:     l.deviceSerial,
      assignedUserId:   l.assignedUserId,
      assignedUserName: l.assignedUserName,
      assignedUserDept: l.assignedUserDept,
      changes:          l.changes || [],
      remarks:          l.remarks,
      actorName:        l.actorName,
      summary:          l.summary,
      createdAt:        l.createdAt,
    }));

    res.json({ total, page: parseInt(page), limit: parseInt(limit), logs: formatted });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
