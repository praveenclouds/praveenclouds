const router = require('express').Router();
const { requireAuth, canManageIntegrations } = require('../../middleware/auth');
const {
  importSlackManifest,
  importManifestJson,
  listSlackWorkflowImports,
} = require('../../services/slack-workflow.service');

router.get('/', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const imports = await listSlackWorkflowImports();
    res.json({
      imports,
      totalSources: imports.length,
      totalWorkflows: imports.reduce((sum, item) => sum + (item.workflowCount || 0), 0),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const { appId, configToken, manifestJson, sourceAppId } = req.body || {};
    const actor = {
      id: req.user?.id || req.user?._id || '',
      name: req.user?.name || '',
      email: req.user?.email || '',
    };

    let imported;
    if (manifestJson && String(manifestJson).trim()) {
      imported = await importManifestJson({
        manifestJson: String(manifestJson),
        sourceAppId: String(sourceAppId || appId || '').trim(),
        actor,
      });
    } else {
      if (!appId || !String(appId).trim()) {
        return res.status(400).json({ error: 'Slack App ID is required.' });
      }
      if (!configToken || !String(configToken).trim()) {
        return res.status(400).json({ error: 'Slack App Configuration Token is required.' });
      }
      imported = await importSlackManifest({
        appId: String(appId).trim(),
        configToken: String(configToken).trim(),
        actor,
      });
    }

    res.json({
      ok: true,
      message: `Imported ${imported.workflowCount} Slack workflow${imported.workflowCount === 1 ? '' : 's'}.`,
      import: imported.toObject ? imported.toObject() : imported,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

module.exports = router;
