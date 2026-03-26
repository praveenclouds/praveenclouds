/**
 * routes/admin/integrations.routes.js — Integration Settings (super_admin only)
 *
 * GET /api/admin/integrations
 * PUT /api/admin/integrations
 */
const router = require('express').Router();
const { IntegrationSettings } = require('../../db');
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');
const { writeLog } = require('../../services/log.service');

// ── GET /api/admin/integrations ────────────────────────────────────────────────
router.get('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const [googleSettings, slackSettings, emailSettings] = await Promise.all([
      IntegrationSettings.findOne({ provider: 'google' }),
      IntegrationSettings.findOne({ provider: 'slack' }),
      IntegrationSettings.findOne({ provider: 'email' }),
    ]);
    res.json({
      google: {
        enabled:         googleSettings ? googleSettings.enabled : false,
        clientId:        '',
        clientSecret:    '',
        hasClientId:     !!(googleSettings && googleSettings.clientId),
        hasClientSecret: !!(googleSettings && googleSettings.clientSecret),
        allowedDomain:   googleSettings ? googleSettings.allowedDomain : '',
      },
      slack: {
        enabled: !!(slackSettings && slackSettings.enabled),
        hasSigningSecret: !!(slackSettings && slackSettings.signingSecret),
      },
      email: {
        enabled: !!(emailSettings && emailSettings.enabled),
        smtpHost: emailSettings ? emailSettings.smtpHost : '',
        smtpPort: emailSettings ? emailSettings.smtpPort : 587,
        smtpSecure: !!(emailSettings && emailSettings.smtpSecure),
        smtpUser: emailSettings ? emailSettings.smtpUser : '',
        fromEmail: emailSettings ? emailSettings.fromEmail : '',
        fromName: emailSettings ? emailSettings.fromName : 'TerzoCloud Support',
        appBaseUrl: emailSettings ? emailSettings.appBaseUrl : '',
        hasSmtpPass: !!(emailSettings && emailSettings.smtpPass),
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── PUT /api/admin/integrations ────────────────────────────────────────────────
router.put('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const hasGooglePayload = Object.prototype.hasOwnProperty.call(req.body || {}, 'google');
    const hasSlackPayload = Object.prototype.hasOwnProperty.call(req.body || {}, 'slack');
    const hasEmailPayload = Object.prototype.hasOwnProperty.call(req.body || {}, 'email');
    const g = req.body.google || {};
    const slack = req.body.slack || {};
    const email = req.body.email || {};
    const tasks = [];

    if (hasGooglePayload) {
      const googleUpdate = {
        enabled:       !!g.enabled,
        allowedDomain: (g.allowedDomain || '').trim().toLowerCase(),
      };
      if (g.clientId && g.clientId.trim()) {
        googleUpdate.clientId = g.clientId.trim();
      }
      if (g.clientSecret && g.clientSecret.trim()) {
        googleUpdate.clientSecret = g.clientSecret.trim();
      }
      tasks.push(
        IntegrationSettings.findOneAndUpdate(
          { provider: 'google' },
          { $set: googleUpdate },
          { upsert: true, new: true }
        )
      );
    }

    if (hasSlackPayload) {
      const slackUpdate = {
        enabled: !!slack.enabled,
      };
      if (slack.signingSecret && slack.signingSecret.trim()) {
        slackUpdate.signingSecret = slack.signingSecret.trim();
      }
      tasks.push(
        IntegrationSettings.findOneAndUpdate(
          { provider: 'slack' },
          { $set: slackUpdate },
          { upsert: true, new: true }
        )
      );
    }

    if (hasEmailPayload) {
      const emailUpdate = {
        enabled: !!email.enabled,
        smtpHost: String(email.smtpHost || '').trim(),
        smtpPort: Number(email.smtpPort || 587),
        smtpSecure: !!email.smtpSecure,
        smtpUser: String(email.smtpUser || '').trim(),
        fromEmail: String(email.fromEmail || '').trim(),
        fromName: String(email.fromName || 'TerzoCloud Support').trim(),
        appBaseUrl: String(email.appBaseUrl || '').trim().replace(/\/+$/, ''),
      };
      if (email.smtpPass && String(email.smtpPass).trim()) {
        emailUpdate.smtpPass = String(email.smtpPass).trim();
      }
      tasks.push(
        IntegrationSettings.findOneAndUpdate(
          { provider: 'email' },
          { $set: emailUpdate },
          { upsert: true, new: true }
        )
      );
    }

    await Promise.all(tasks);

    // Audit-log which providers were updated (never log secret values).
    const updatedProviders = [];
    if (hasGooglePayload) updatedProviders.push('google');
    if (hasSlackPayload) updatedProviders.push('slack');
    if (hasEmailPayload) updatedProviders.push('email');
    await writeLog({
      eventType:   'settings_updated',
      entityType:  'integration',
      entityId:    'integration_settings',
      entityLabel: 'Integration Settings',
      summary:     `Integration settings updated by admin — providers: ${updatedProviders.join(', ') || 'none'}`,
    });

    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

module.exports = router;
