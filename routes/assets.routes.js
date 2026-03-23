/**
 * routes/assets.routes.js — Asset management
 *
 * GET    /api/assets
 * POST   /api/assets
 * PUT    /api/assets/:id
 * DELETE /api/assets/:id
 */
const router = require('express').Router();
const { Asset, User } = require('../db');
const { requireAuth, canWriteAssets } = require('../middleware/auth');
const { fmt, diffObjects } = require('../utils/format');
const { writeLog } = require('../services/log.service');

const TRACKED_ASSET_FIELDS = ['name', 'type', 'serial', 'brand', 'desc', 'status', 'location', 'vendor', 'notes'];

// ── GET /api/assets ────────────────────────────────────────────────────────────
// Supports optional ?page=1&limit=200 query params.
// Defaults to returning all records (backward-compatible flat array).
router.get('/', requireAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.max(0, parseInt(req.query.limit) || 0); // 0 = no limit (default)

    const query = Asset.find().sort({ csvId: 1 });
    if (limit > 0) {
      const total  = await Asset.countDocuments();
      const assets = await query.skip((page - 1) * limit).limit(limit);
      return res.json({ total, page, limit, assets: assets.map(fmt) });
    }
    const assets = await query;
    res.json(assets.map(fmt));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/assets ───────────────────────────────────────────────────────────
router.post('/', requireAuth, canWriteAssets, async (req, res) => {
  try {
    const body  = { ...req.body };
    if (!body.assignedTo) body.assignedTo = null;
    const asset = await Asset.create(body);
    const a     = fmt(asset);

    if (a.assignedTo) {
      const assignedUser = await User.findById(a.assignedTo).lean();
      await writeLog({
        eventType:        'device_allocated',
        entityType:       'asset',
        entityId:         a.id,
        entityLabel:      `${a.name} (${a.csvId})`,
        deviceId:         a.csvId,
        deviceType:       a.type,
        deviceModel:      a.name,
        deviceSerial:     a.serial || '',
        assignedUserId:   a.assignedTo,
        assignedUserName: assignedUser ? `${assignedUser.first} ${assignedUser.last}` : '',
        assignedUserDept: assignedUser?.dept || '',
        summary: `${a.name} (${a.csvId}) allocated to ${assignedUser ? assignedUser.first + ' ' + assignedUser.last : 'Unknown'} [${assignedUser?.dept || ''}]`,
      });
    } else {
      await writeLog({
        eventType:   'asset_created',
        entityType:  'asset',
        entityId:    a.id,
        entityLabel: `${a.name} (${a.csvId})`,
        deviceId:    a.csvId,
        deviceType:  a.type,
        deviceModel: a.name,
        deviceSerial:a.serial || '',
        summary:     `New asset added: ${a.name} (${a.csvId}) — ${a.type}`,
      });
    }
    res.status(201).json(a);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/assets/:id ────────────────────────────────────────────────────────
router.put('/:id', requireAuth, canWriteAssets, async (req, res) => {
  try {
    const body     = { ...req.body };
    if (!body.assignedTo) body.assignedTo = null;

    const oldAsset = await Asset.findById(req.params.id).lean();
    const asset    = await Asset.findByIdAndUpdate(req.params.id, body, {
      new: true, runValidators: true,
    });
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    const a = fmt(asset);

    const oldAssigned = oldAsset?.assignedTo ? oldAsset.assignedTo.toString() : null;
    const newAssigned = body.assignedTo || null;

    if (oldAssigned !== newAssigned) {
      if (newAssigned) {
        const assignedUser = await User.findById(newAssigned).lean();
        await writeLog({
          eventType:        'device_allocated',
          entityType:       'asset',
          entityId:         a.id,
          entityLabel:      `${a.name} (${a.csvId})`,
          deviceId:         a.csvId,
          deviceType:       a.type,
          deviceModel:      a.name,
          deviceSerial:     a.serial || '',
          assignedUserId:   newAssigned,
          assignedUserName: assignedUser ? `${assignedUser.first} ${assignedUser.last}` : '',
          assignedUserDept: assignedUser?.dept || '',
          summary: `${a.name} (${a.csvId}) allocated to ${assignedUser ? assignedUser.first + ' ' + assignedUser.last : 'Unknown'} [${assignedUser?.dept || ''}]`,
        });
      } else {
        let prevUserName = '';
        if (oldAssigned) {
          const prevUser = await User.findById(oldAssigned).lean();
          prevUserName   = prevUser ? `${prevUser.first} ${prevUser.last}` : oldAssigned;
        }
        await writeLog({
          eventType:        'device_unassigned',
          entityType:       'asset',
          entityId:         a.id,
          entityLabel:      `${a.name} (${a.csvId})`,
          deviceId:         a.csvId,
          deviceType:       a.type,
          deviceModel:      a.name,
          deviceSerial:     a.serial || '',
          assignedUserName: prevUserName,
          summary:          `${a.name} (${a.csvId}) unassigned from ${prevUserName}`,
        });
      }
    } else {
      const changes = diffObjects(oldAsset || {}, body, TRACKED_ASSET_FIELDS);
      if (changes.length > 0) {
        await writeLog({
          eventType:   'asset_updated',
          entityType:  'asset',
          entityId:    a.id,
          entityLabel: `${a.name} (${a.csvId})`,
          deviceId:    a.csvId,
          deviceType:  a.type,
          deviceModel: a.name,
          deviceSerial:a.serial || '',
          changes,
          summary: `Asset updated: ${a.name} (${a.csvId}) — ${changes.map(c => c.field).join(', ')} changed`,
        });
      }
    }
    res.json(a);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /api/assets/:id ─────────────────────────────────────────────────────
router.delete('/:id', requireAuth, canWriteAssets, async (req, res) => {
  try {
    const asset = await Asset.findByIdAndDelete(req.params.id);
    if (!asset) return res.status(404).json({ error: 'Asset not found' });
    await writeLog({
      eventType:   'asset_deleted',
      entityType:  'asset',
      entityId:    req.params.id,
      entityLabel: `${asset.name} (${asset.csvId})`,
      deviceId:    asset.csvId,
      deviceType:  asset.type,
      deviceModel: asset.name,
      deviceSerial:asset.serial || '',
      summary:     `Asset deleted: ${asset.name} (${asset.csvId})`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
