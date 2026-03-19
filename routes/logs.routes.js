/**
 * routes/logs.routes.js — Audit Logs
 *
 * GET /api/logs?type=&entityType=&search=&page=&limit=
 */
const router = require('express').Router();
const { Log }  = require('../db');
const { requireAuth, canViewActivityLog } = require('../middleware/auth');

// ── GET /api/logs ──────────────────────────────────────────────────────────────
router.get('/', requireAuth, canViewActivityLog, async (req, res) => {
  try {
    const { type, entityType, search, page = 1, limit = 25 } = req.query;

    const filter = {};
    if (type)       filter.eventType  = type;
    if (entityType) filter.entityType = entityType;
    if (search) {
      const re = new RegExp(search, 'i');
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
