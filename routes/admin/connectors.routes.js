/**
 * routes/admin/connectors.routes.js — App Connector Management (super_admin only)
 *
 * GET  /api/admin/connectors           — list all connectors (token masked)
 * PUT  /api/admin/connectors/:app      — save / upsert connector config
 * POST /api/admin/connectors/:app/test — test live connection
 * POST /api/admin/connectors/:app/sync — full sync + update Software record
 */
const router = require('express').Router();
const { AppConnector, Software } = require('../../db');
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');
const { syncConnector } = require('../../services/connector.service');
const { encryptSecret, decryptSecret } = require('../../utils/secret-crypto');
const { sanitizeSlackToken, normalizeSlackBotToken } = require('../../utils/slack-token');

const HEADER_UNSAFE_OR_ZERO_WIDTH_RE = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g;
function sanitizeToken(value = '') {
  return String(value || '')
    .replace(HEADER_UNSAFE_OR_ZERO_WIDTH_RE, '')
    .trim();
}

function validateConnectorToken(appName = '', token = '') {
  if (!token) throw new Error('API token cannot be empty.');
  if (/\s/.test(token)) throw new Error('API token contains whitespace or line-break characters. Paste a single-line token.');

  if (String(appName || '').toLowerCase() === 'slack') {
    normalizeSlackBotToken(token, { label: 'Slack Bot Token' });
  }
}

// ── GET /api/admin/connectors ─────────────────────────────────────────────────
router.get('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const connectors = await AppConnector.find().lean();
    // Mask the raw apiToken — return a presence flag only
    const safe = connectors.map(c => ({ ...c, apiToken: undefined, hasToken: !!(c.apiToken) }));
    res.json(safe);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/admin/connectors/:app ────────────────────────────────────────────
router.put('/:app', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const appName  = req.params.app;
    const { enabled, orgSlug, softwareCsvId, apiToken } = req.body;

    const update = {
      enabled:       !!enabled,
      orgSlug:       orgSlug       || '',
      softwareCsvId: softwareCsvId || '',
    };

    // Only overwrite the stored token when a real, non-masked value is provided
    if (apiToken && apiToken !== '••••••••' && apiToken !== '[key stored]') {
      const normalizedToken = String(appName || '').toLowerCase() === 'slack'
        ? sanitizeSlackToken(apiToken)
        : sanitizeToken(apiToken);
      validateConnectorToken(appName, normalizedToken);
      update.apiToken = encryptSecret(normalizedToken);
      update.tokenHint = normalizedToken.length > 4 ? normalizedToken.slice(-4) : '****';
    }

    const connector = await AppConnector.findOneAndUpdate(
      { appName },
      { ...update, displayName: update.displayName || appName },
      { new: true, upsert: true, runValidators: true }
    );
    res.json({ ...connector.toObject(), apiToken: undefined, hasToken: !!(connector.apiToken) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── POST /api/admin/connectors/:app/test ──────────────────────────────────────
router.post('/:app/test', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const appName   = req.params.app;
    const connector = await AppConnector.findOne({ appName });
    if (!connector || !connector.apiToken) {
      return res.status(400).json({ ok: false, message: 'Connector not configured. Save API token first.' });
    }
    // Decrypt token before passing to service
    const connObj = connector.toObject();
    connObj.apiToken = String(appName || '').toLowerCase() === 'slack'
      ? normalizeSlackBotToken(decryptSecret(connObj.apiToken), { label: 'Slack Bot Token' })
      : sanitizeToken(decryptSecret(connObj.apiToken));
    validateConnectorToken(appName, connObj.apiToken);
    const result = await syncConnector(connObj);
    res.json({ ok: true, message: result.message, userCount: result.userCount, plan: result.plan });
  } catch (e) {
    res.json({ ok: false, message: e.message });
  }
});

// ── POST /api/admin/connectors/:app/sync ─────────────────────────────────────
router.post('/:app/sync', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const appName   = req.params.app;
    const connector = await AppConnector.findOne({ appName });
    if (!connector || !connector.apiToken) {
      return res.status(400).json({ ok: false, message: 'Connector not configured.' });
    }
    // Decrypt token before passing to service
    const connObj = connector.toObject();
    connObj.apiToken = String(appName || '').toLowerCase() === 'slack'
      ? normalizeSlackBotToken(decryptSecret(connObj.apiToken), { label: 'Slack Bot Token' })
      : sanitizeToken(decryptSecret(connObj.apiToken));
    validateConnectorToken(appName, connObj.apiToken);
    const result = await syncConnector(connObj);

    // Update linked Software Inventory record
    let softwareUpdated = false;
    if (connector.softwareCsvId) {
      const swUpdate = { usedLicenses: result.userCount };
      if (result.plan)              swUpdate.subscriptionPlan  = result.plan;
      if (result.purchasedLicenses) swUpdate.purchasedLicenses = result.purchasedLicenses;
      const sw = await Software.findOneAndUpdate({ csvId: connector.softwareCsvId }, swUpdate, { new: true });
      softwareUpdated = !!sw;
    }

    // Persist sync status
    await AppConnector.findOneAndUpdate({ appName }, {
      lastSyncAt:      new Date(),
      lastSyncStatus:  'success',
      lastSyncMessage: result.message,
      cachedUserCount: result.userCount,
      cachedPlan:      result.plan || '',
    });

    res.json({
      ok: true,
      message:       result.message,
      userCount:     result.userCount,
      plan:          result.plan,
      softwareUpdated,
      softwareCsvId: connector.softwareCsvId || null,
    });
  } catch (e) {
    // Persist error status even on failure
    await AppConnector.findOneAndUpdate(
      { appName: req.params.app },
      { lastSyncAt: new Date(), lastSyncStatus: 'error', lastSyncMessage: e.message }
    );
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
