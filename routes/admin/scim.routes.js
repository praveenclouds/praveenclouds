/**
 * routes/admin/scim.routes.js — SCIM Config Admin (super_admin only)
 *
 * GET  /api/admin/scim                  — return config (token hint only)
 * PUT  /api/admin/scim                  — toggle enabled flag
 * POST /api/admin/scim/regenerate-token — generate new bearer token (shown once)
 */
const router  = require('express').Router();
const crypto  = require('crypto');
const { SCIMConfig } = require('../../db');
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');

// ── GET /api/admin/scim ────────────────────────────────────────────────────────
router.get('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const cfg = await SCIMConfig.findOne() || {};
    res.json({
      enabled:     cfg.enabled   || false,
      tokenHint:   cfg.tokenHint || '',
      hasToken:    !!(cfg.bearerToken),
      scimBaseUrl: `${req.protocol}://${req.get('host')}/scim/v2`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/admin/scim ────────────────────────────────────────────────────────
router.put('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const { enabled } = req.body;
    const cfg = await SCIMConfig.findOneAndUpdate(
      {},
      { enabled: !!enabled },
      { new: true, upsert: true }
    );
    res.json({ enabled: cfg.enabled, tokenHint: cfg.tokenHint, hasToken: !!(cfg.bearerToken) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/scim/regenerate-token ─────────────────────────────────────
router.post('/regenerate-token', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const token     = crypto.randomBytes(32).toString('hex'); // 64-char hex
    const tokenHint = token.slice(-6);
    await SCIMConfig.findOneAndUpdate(
      {},
      { bearerToken: token, tokenHint },
      { upsert: true }
    );
    // Return full token ONCE — never retrievable from the UI again
    res.json({ token, tokenHint });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
