const { apiPostForm } = require('../utils/http');
const { SlackWorkflowImport } = require('../db');

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function parseManifestJson(manifestJson) {
  let parsed;
  try {
    parsed = JSON.parse(manifestJson);
  } catch {
    throw new Error('Manifest JSON is not valid JSON.');
  }

  if (parsed && typeof parsed.manifest === 'object') return parsed.manifest;
  if (parsed && typeof parsed === 'object') return parsed;
  throw new Error('Manifest JSON must decode to an object.');
}

function extractTriggerTypes(workflow) {
  if (!workflow || !workflow.triggers) return [];

  if (Array.isArray(workflow.triggers)) {
    return workflow.triggers
      .map(trigger => trigger?.type || trigger?.name || '')
      .filter(Boolean);
  }

  if (typeof workflow.triggers === 'object') {
    return Object.keys(workflow.triggers).filter(Boolean);
  }

  return [];
}

function normalizeWorkflows(manifest) {
  const workflows = manifest?.workflows;
  const entries = Array.isArray(workflows)
    ? workflows.map((workflow, index) => [workflow?.callback_id || workflow?.name || `workflow_${index + 1}`, workflow])
    : Object.entries(workflows || {});

  return entries.map(([entryKey, workflow]) => {
    const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
    const callbackId = workflow?.callback_id || entryKey || '';
    const title = workflow?.title || workflow?.name || callbackId || 'Untitled workflow';

    return {
      key: callbackId || slugify(title) || `workflow-${Date.now()}`,
      title,
      description: workflow?.description || '',
      callbackId,
      triggerTypes: extractTriggerTypes(workflow),
      stepCount: steps.length,
      steps,
      raw: workflow || {},
    };
  });
}

function buildImportPayload({ manifest, sourceType, sourceAppId, actor }) {
  const sourceAppName = manifest?.display_information?.name || manifest?.display_information?.description || '';
  const normalizedSourceId = sourceAppId || manifest?.app_id || slugify(sourceAppName) || 'manual-import';
  const workflows = normalizeWorkflows(manifest);

  if (workflows.length === 0) {
    throw new Error('No workflows were found in the Slack app manifest.');
  }

  return {
    sourceType,
    sourceAppId: normalizedSourceId,
    sourceAppName: sourceAppName || normalizedSourceId,
    manifestVersion: String(manifest?._metadata?.major_version || manifest?._metadata?.version || ''),
    workflowCount: workflows.length,
    workflows,
    importedAt: new Date(),
    importedBy: {
      id: String(actor?.id || ''),
      name: actor?.name || '',
      email: actor?.email || '',
    },
  };
}

function buildSlackAuthHelp(appId, configToken) {
  const token = String(configToken || '').trim();
  const reasons = [
    'Use a Slack app configuration access token for the same workspace as the app.',
    'Do not use a bot token (`xoxb-`) or app-level token (`xapp-`) here.',
    'Do not use the refresh token (`xoxe-`) here; use the current config access token instead.',
    'Slack config access tokens expire after 12 hours, so generate or rotate a fresh one if needed.',
  ];

  if (token.startsWith('xapp-')) reasons.unshift('The token entered looks like an app-level token (`xapp-`), which Slack will reject for `apps.manifest.export`.');
  else if (token.startsWith('xoxb-')) reasons.unshift('The token entered looks like a bot token (`xoxb-`), which Slack will reject for `apps.manifest.export`.');
  else if (token.startsWith('xoxe-') && !token.startsWith('xoxe.xoxp-')) reasons.unshift('The token entered looks like a refresh token (`xoxe-`), not the active config access token.');
  else if (!token.startsWith('xoxe.xoxp-')) reasons.unshift('Slack config access tokens commonly look like `xoxe.xoxp-...`.');

  if (appId) reasons.push(`Confirm that App ID \`${appId}\` belongs to the same workspace where the config token was generated.`);
  return reasons.join(' ');
}

async function importSlackManifest({ appId, configToken, actor }) {
  const raw = await apiPostForm(
    'slack.com',
    '/api/apps.manifest.export',
    { app_id: appId, token: configToken },
    {
      Accept: 'application/json',
    }
  );

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    const snippet = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 180);
    if (/<!doctype|<html/i.test(String(raw || ''))) {
      throw new Error(`Slack returned HTML instead of JSON. Double-check the App Configuration token and App ID. Response snippet: ${snippet}`);
    }
    throw new Error(`Slack returned an unexpected non-JSON response. Response snippet: ${snippet}`);
  }
  if (!data.ok) {
    if (data.error === 'invalid_auth') {
      throw new Error(`Slack rejected the token with \`invalid_auth\`. ${buildSlackAuthHelp(appId, configToken)}`);
    }
    throw new Error(data.error || 'Slack manifest export failed');
  }
  if (!data.manifest || typeof data.manifest !== 'object') {
    throw new Error('Slack did not return a manifest payload.');
  }

  const payload = buildImportPayload({
    manifest: data.manifest,
    sourceType: 'slack_manifest_export',
    sourceAppId: appId,
    actor,
  });

  return SlackWorkflowImport.findOneAndUpdate(
    { sourceAppId: payload.sourceAppId },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function importManifestJson({ manifestJson, sourceAppId, actor }) {
  const manifest = parseManifestJson(manifestJson);
  const payload = buildImportPayload({
    manifest,
    sourceType: 'manifest_json',
    sourceAppId,
    actor,
  });

  return SlackWorkflowImport.findOneAndUpdate(
    { sourceAppId: payload.sourceAppId },
    { $set: payload },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function listSlackWorkflowImports() {
  return SlackWorkflowImport.find().sort({ importedAt: -1, updatedAt: -1 }).lean();
}

module.exports = {
  importSlackManifest,
  importManifestJson,
  listSlackWorkflowImports,
};
