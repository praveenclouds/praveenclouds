const router = require('express').Router();
const { AlertRule } = require('../../db');
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');
const { writeLog } = require('../../services/log.service');

const ALLOWED_CHANNELS = new Set(['inApp', 'email', 'slack']);
const ALLOWED_CATEGORIES = new Set(['users', 'software', 'assets']);

function normalizeChannels(value) {
  const raw = Array.isArray(value) ? value : [];
  const unique = [...new Set(raw.map(channel => String(channel || '').trim()).filter(Boolean))];
  const filtered = unique.filter(channel => ALLOWED_CHANNELS.has(channel));
  return filtered.length ? filtered : ['inApp'];
}

function toNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatAlertRule(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    category: doc.category,
    condition: doc.condition,
    threshold: doc.threshold === undefined ? null : doc.threshold,
    description: doc.description || '',
    channels: Array.isArray(doc.channels) ? doc.channels : ['inApp'],
    enabled: doc.enabled !== false,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

router.get('/', requireAuth, async (req, res) => {
  try {
    const rules = await AlertRule.find({}).sort({ createdAt: -1 }).lean();
    res.json(rules.map(formatAlertRule));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const category = String(req.body?.category || '').trim();
    const condition = String(req.body?.condition || '').trim();
    if (!name || !condition || !ALLOWED_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'name, category and condition are required' });
    }
    const actor = req.user?.name || req.user?.email || 'unknown';
    const rule = await AlertRule.create({
      name,
      category,
      condition,
      threshold: toNumberOrNull(req.body?.threshold),
      description: String(req.body?.description || '').trim(),
      channels: normalizeChannels(req.body?.channels),
      enabled: req.body?.enabled !== false,
      createdBy: actor,
      updatedBy: actor,
    });
    await writeLog({
      eventType: 'alert_rule_created',
      entityType: 'alert_rule',
      entityId: rule._id.toString(),
      entityLabel: rule.name,
      actorName: actor,
      summary: `Alert rule created: ${rule.name} (${rule.category})`,
    });
    res.status(201).json(formatAlertRule(rule));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const category = String(req.body?.category || '').trim();
    const condition = String(req.body?.condition || '').trim();
    if (!name || !condition || !ALLOWED_CATEGORIES.has(category)) {
      return res.status(400).json({ error: 'name, category and condition are required' });
    }
    const actor = req.user?.name || req.user?.email || 'unknown';
    const rule = await AlertRule.findByIdAndUpdate(
      req.params.id,
      {
        name,
        category,
        condition,
        threshold: toNumberOrNull(req.body?.threshold),
        description: String(req.body?.description || '').trim(),
        channels: normalizeChannels(req.body?.channels),
        enabled: req.body?.enabled !== false,
        updatedBy: actor,
      },
      { new: true, runValidators: true }
    );
    if (!rule) return res.status(404).json({ error: 'Alert rule not found' });
    await writeLog({
      eventType: 'alert_rule_updated',
      entityType: 'alert_rule',
      entityId: rule._id.toString(),
      entityLabel: rule.name,
      actorName: actor,
      summary: `Alert rule updated: ${rule.name} (${rule.category})`,
    });
    res.json(formatAlertRule(rule));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const actor = req.user?.name || req.user?.email || 'unknown';
    const rule = await AlertRule.findByIdAndDelete(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Alert rule not found' });
    await writeLog({
      eventType: 'alert_rule_deleted',
      entityType: 'alert_rule',
      entityId: req.params.id,
      entityLabel: rule.name,
      actorName: actor,
      summary: `Alert rule deleted: ${rule.name} (${rule.category})`,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

