/**
 * services/connector.service.js — App connector sync & invite logic
 *
 * Sync functions read live user/license data from each app's API
 * and return a normalised result object.
 *
 * Invite functions trigger user provisioning in each app when
 * app access is granted via PUT /api/users/:id/app-access.
 *
 * Supported connectors: github, slack, google_workspace
 * (zoom, microsoft_365, aws — sync stubs ready for future implementation)
 */
const { apiGet, apiPost } = require('../utils/http');

// ══════════════════════════════════════════════════════════════════
//  SYNC FUNCTIONS
// ══════════════════════════════════════════════════════════════════

async function syncGitHub(connector) {
  const headers = {
    Authorization:         `Bearer ${connector.apiToken}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent':           'Terzo-Portal/1.0',
    Accept:                 'application/vnd.github+json',
  };

  // Org info (plan + seats)
  const orgData = await apiGet(
    `https://api.github.com/orgs/${encodeURIComponent(connector.orgSlug)}`,
    headers
  );

  // Members list — paginated, max 100 per page
  let members = [], page = 1;
  while (true) {
    const batch = await apiGet(
      `https://api.github.com/orgs/${encodeURIComponent(connector.orgSlug)}/members?per_page=100&page=${page}`,
      headers
    );
    const arr = JSON.parse(batch);
    if (!Array.isArray(arr) || arr.length === 0) break;
    members = members.concat(arr);
    if (arr.length < 100) break;
    page++;
  }

  const org  = JSON.parse(orgData);
  const plan = org.plan || {};

  return {
    userCount:         members.length,
    purchasedLicenses: plan.seats || members.length,
    plan:              plan.name ? `GitHub ${plan.name.charAt(0).toUpperCase() + plan.name.slice(1)}` : (connector.cachedPlan || ''),
    message:           `${members.length} active members · Plan: ${plan.name || 'unknown'}`,
  };
}

async function syncSlack(connector) {
  const authHeader = { Authorization: `Bearer ${connector.apiToken}` };

  // Users list
  const usersRaw  = await apiGet('https://slack.com/api/users.list?limit=500', authHeader);
  const usersData = JSON.parse(usersRaw);
  if (!usersData.ok) throw new Error(usersData.error || 'Slack API error');

  const activeMembers = (usersData.members || []).filter(
    m => !m.is_bot && !m.deleted && m.id !== 'USLACKBOT'
  );

  // Team info
  const teamRaw  = await apiGet('https://slack.com/api/team.info', authHeader);
  const teamData = JSON.parse(teamRaw);
  const plan     = teamData.ok ? (teamData.team.plan || 'Business+') : '';

  return {
    userCount: activeMembers.length,
    plan:      plan ? `Slack ${plan.charAt(0).toUpperCase() + plan.slice(1)}` : '',
    message:   `${activeMembers.length} active members · Plan: ${plan || 'unknown'}`,
  };
}

async function syncGoogleWorkspace(connector) {
  // Parse service account JSON
  let sa;
  try { sa = JSON.parse(connector.apiToken); } catch { throw new Error('Invalid service account JSON'); }

  // Build JWT for service account auth
  const jwt = require('jsonwebtoken');
  const now  = Math.floor(Date.now() / 1000);
  const claim = {
    iss:   sa.client_email,
    scope: 'https://www.googleapis.com/auth/admin.directory.user.readonly',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
    sub:   connector.orgSlug, // admin email for impersonation
  };

  const jwtToken = jwt.sign(claim, sa.private_key, { algorithm: 'RS256' });

  // Exchange JWT for access token
  const tokenBody = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwtToken}`;
  const tokenRaw  = await apiPost(
    'oauth2.googleapis.com', '/token',
    tokenBody, { 'Content-Type': 'application/x-www-form-urlencoded' }
  );
  const tokenData = JSON.parse(tokenRaw);
  if (!tokenData.access_token)
    throw new Error(tokenData.error_description || 'Failed to get access token');

  // Extract domain from admin email
  const domain = (connector.orgSlug || '').split('@')[1] || connector.orgSlug;

  // List active users
  const usersRaw  = await apiGet(
    `https://admin.googleapis.com/admin/directory/v1/users?domain=${encodeURIComponent(domain)}&maxResults=500&orderBy=email`,
    { Authorization: `Bearer ${tokenData.access_token}` }
  );
  const usersData = JSON.parse(usersRaw);
  const users     = (usersData.users || []).filter(u => !u.suspended && !u.archived);

  return {
    userCount: users.length,
    plan:      'Google Workspace Enterprise Standard',
    message:   `${users.length} active users in ${domain}`,
  };
}

// ── Sync dispatcher — routes to the correct sync function ─────────────────────
const SYNC_HANDLERS = {
  github:           syncGitHub,
  slack:            syncSlack,
  google_workspace: syncGoogleWorkspace,
  // zoom, microsoft_365, aws — add sync handlers here when implementing
};

async function syncConnector(connector) {
  const handler = SYNC_HANDLERS[connector.appName];
  if (!handler) throw new Error(`No sync handler for connector: ${connector.appName}`);
  return handler(connector);
}

// ══════════════════════════════════════════════════════════════════
//  INVITE FUNCTIONS  (triggered on app access grant)
// ══════════════════════════════════════════════════════════════════

async function inviteGitHub(connector, user) {
  try {
    const raw = await apiPost(
      'api.github.com',
      `/orgs/${encodeURIComponent(connector.orgSlug)}/invitations`,
      JSON.stringify({ email: user.email, role: 'direct_member' }),
      {
        Authorization:         `Bearer ${connector.apiToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        Accept:                 'application/vnd.github+json',
      }
    );
    const data = JSON.parse(raw);
    if (data.id) return { status: 'invited', message: `GitHub org invitation sent to ${user.email}` };
    return { status: 'error', message: data.message || 'GitHub invite failed' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

async function inviteSlack(connector, user) {
  try {
    const raw = await apiPost(
      'slack.com',
      '/api/admin.users.invite',
      JSON.stringify({ email: user.email, team_id: connector.orgSlug, channel_ids: [] }),
      { Authorization: `Bearer ${connector.apiToken}` }
    );
    const data = JSON.parse(raw);
    if (data.ok) return { status: 'invited', message: `Slack invitation sent to ${user.email}` };
    // Non-Enterprise Grid workspaces can't auto-invite — degrade gracefully
    if (['enterprise_is_restricted','not_allowed','method_not_supported_for_channel_type',
         'paid_only','ratelimited'].includes(data.error)) {
      return { status: 'manual', message: `Slack auto-invite requires Enterprise Grid. Please invite ${user.email} manually.` };
    }
    return { status: 'error', message: data.error || 'Slack invite failed' };
  } catch (e) {
    return { status: 'error', message: e.message };
  }
}

/**
 * Dispatch an app invite for a newly granted user.
 * Returns { status, message } — status: 'invited' | 'manual' | 'skipped' | 'unsupported' | 'error'
 */
async function sendAppInvite(connector, user) {
  if (connector.appName === 'github')           return inviteGitHub(connector, user);
  if (connector.appName === 'slack')            return inviteSlack(connector, user);
  if (connector.appName === 'google_workspace') return { status: 'skipped', message: 'Google Workspace users are provisioned via SCIM — no separate invite needed.' };
  return { status: 'unsupported', message: `Auto-invite is not supported for ${connector.appName}` };
}

module.exports = { syncConnector, sendAppInvite };
