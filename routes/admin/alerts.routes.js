const router = require('express').Router();
const { AlertRule, AlertConfig } = require('../../db');
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');
const { writeLog } = require('../../services/log.service');

const ALLOWED_CHANNELS = new Set(['inApp', 'email', 'slack']);
const ALLOWED_CATEGORIES = new Set(['users', 'software', 'assets']);
const ALERT_CONFIG_KEY = 'default';

function normalizeInventory(value = {}) {
  return {
    users: value?.users !== false,
    software: value?.software !== false,
    assets: value?.assets !== false,
  };
}

function normalizeNotificationOptions(value = {}) {
  return {
    inApp: value?.inApp !== false,
    email: value?.email === true,
    slack: value?.slack === true,
  };
}

function channelsFromNotifications(notifications = {}) {
  const channels = [];
  if (notifications.inApp) channels.push('inApp');
  if (notifications.email) channels.push('email');
  if (notifications.slack) channels.push('slack');
  return normalizeChannels(channels);
}

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

function formatAlertConfig(doc) {
  const inventory = normalizeInventory(doc?.inventory || {});
  const notifications = normalizeNotificationOptions(doc?.notifications || {});
  return {
    key: ALERT_CONFIG_KEY,
    inventory,
    notifications,
    updatedAt: doc?.updatedAt || null,
    createdAt: doc?.createdAt || null,
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

router.get('/config', requireAuth, async (req, res) => {
  try {
    const doc = await AlertConfig.findOne({ key: ALERT_CONFIG_KEY }).lean();
    res.json(formatAlertConfig(doc || {}));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/config', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const actor = req.user?.name || req.user?.email || 'unknown';
    const inventory = normalizeInventory(req.body?.inventory || {});
    const notifications = normalizeNotificationOptions(req.body?.notifications || {});

    const doc = await AlertConfig.findOneAndUpdate(
      { key: ALERT_CONFIG_KEY },
      {
        $set: {
          key: ALERT_CONFIG_KEY,
          inventory,
          notifications,
          updatedBy: actor,
        },
        $setOnInsert: { createdBy: actor },
      },
      { upsert: true, new: true }
    );

    await writeLog({
      eventType: 'alert_config_updated',
      entityType: 'alert_config',
      entityId: ALERT_CONFIG_KEY,
      entityLabel: 'Alerts Configuration',
      actorName: actor,
      summary: `Alerts configuration updated (inventory: users=${inventory.users}, software=${inventory.software}, assets=${inventory.assets})`,
    });

    res.json(formatAlertConfig(doc));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

router.post('/sync', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const actor = req.user?.name || req.user?.email || 'unknown';
    const inventory = normalizeInventory(req.body?.inventory || {});
    const notifications = normalizeNotificationOptions(req.body?.notifications || {});
    const channels = channelsFromNotifications(notifications);
    const conditions = Array.isArray(req.body?.conditions) ? req.body.conditions : [];

    const normalizedConditions = [];
    for (const row of conditions) {
      const category = String(row?.category || '').trim();
      const condition = String(row?.condition || '').trim();
      if (!ALLOWED_CATEGORIES.has(category) || !condition) continue;
      normalizedConditions.push({
        category,
        condition,
        enabled: row?.enabled === true,
        threshold: toNumberOrNull(row?.threshold),
        name: String(row?.name || '').trim(),
        description: String(row?.description || '').trim(),
      });
    }

    // Upsert every passed condition as a managed rule.
    for (const row of normalizedConditions) {
      const categoryEnabled = inventory[row.category] !== false;
      const finalEnabled = categoryEnabled && row.enabled;
      const autoName = `${row.category[0].toUpperCase()}${row.category.slice(1)}: ${row.condition}`;
      const preferredName = row.name || autoName;

      const rule = await AlertRule.findOneAndUpdate(
        { category: row.category, condition: row.condition },
        {
          $set: {
            name: preferredName,
            description: row.description,
            threshold: row.threshold,
            channels,
            enabled: finalEnabled,
            updatedBy: actor,
          },
          $setOnInsert: {
            createdBy: actor,
          },
        },
        { upsert: true, new: true, runValidators: true }
      );

      // Defensive cleanup if there are legacy duplicates with same category+condition.
      await AlertRule.updateMany(
        { category: row.category, condition: row.condition, _id: { $ne: rule._id } },
        { $set: { enabled: false, updatedBy: actor } }
      );
    }

    // If an inventory is disabled, force-disable all rules in that category.
    const disabledCategories = Object.entries(inventory)
      .filter(([, enabled]) => enabled === false)
      .map(([category]) => category);
    if (disabledCategories.length) {
      await AlertRule.updateMany(
        { category: { $in: disabledCategories } },
        { $set: { enabled: false, updatedBy: actor } }
      );
    }

    const configDoc = await AlertConfig.findOneAndUpdate(
      { key: ALERT_CONFIG_KEY },
      {
        $set: {
          key: ALERT_CONFIG_KEY,
          inventory,
          notifications,
          updatedBy: actor,
        },
        $setOnInsert: { createdBy: actor },
      },
      { upsert: true, new: true }
    );

    const rules = await AlertRule.find({}).sort({ createdAt: -1 }).lean();
    await writeLog({
      eventType: 'alert_config_updated',
      entityType: 'alert_config',
      entityId: ALERT_CONFIG_KEY,
      entityLabel: 'Alerts Configuration',
      actorName: actor,
      summary: `Alert sync applied (${normalizedConditions.length} conditions, channels=${channels.join(',')})`,
    });

    res.json({
      ok: true,
      config: formatAlertConfig(configDoc),
      rules: rules.map(formatAlertRule),
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
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
