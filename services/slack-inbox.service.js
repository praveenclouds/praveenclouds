const { AppConnector } = require('../db');
const { apiPostForm } = require('../utils/http');
const { resolveSlackBotToken } = require('../utils/slack-token');

const slackUserByEmailCache = new Map();
const SLACK_USER_DIRECTORY_TTL_MS = 5 * 60 * 1000;
let slackUserDirectoryCache = {
  byEmail: new Map(),
  expiresAt: 0,
};

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeSlackMessageInput(message) {
  if (typeof message === 'string') {
    return {
      text: String(message || '').trim(),
      blocks: [],
    };
  }

  if (message && typeof message === 'object') {
    const text = String(message.text || '').trim();
    const blocks = Array.isArray(message.blocks) ? message.blocks : [];
    return { text, blocks };
  }

  return { text: '', blocks: [] };
}

async function getSlackBotToken() {
  const connector = await AppConnector.findOne({ appName: 'slack' }).lean();
  if (!connector?.apiToken) {
    throw new Error('Slack Bot Token is not configured.');
  }
  return resolveSlackBotToken(connector.apiToken, { label: 'Slack Bot Token' });
}

async function callSlackFormApi(path, body = {}) {
  const token = await getSlackBotToken();
  const raw = await apiPostForm(
    'slack.com',
    path,
    body,
    {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    }
  );

  const data = JSON.parse(raw);
  if (!data.ok) throw new Error(data.error || `Slack API call failed: ${path}`);
  return data;
}

function indexSlackMemberEmail(byEmail, member = {}) {
  const email = normalizeEmail(member?.profile?.email || '');
  const userId = String(member?.id || '').trim();
  if (!email || !userId) return;
  byEmail.set(email, userId);
}

async function loadSlackUserDirectory(forceReload = false) {
  const now = Date.now();
  if (!forceReload && slackUserDirectoryCache.expiresAt > now && slackUserDirectoryCache.byEmail.size) {
    return slackUserDirectoryCache.byEmail;
  }

  const byEmail = new Map();
  let cursor = '';
  let loops = 0;
  do {
    const payload = { limit: 200 };
    if (cursor) payload.cursor = cursor;
    const data = await callSlackFormApi('/api/users.list', payload);
    const members = Array.isArray(data?.members) ? data.members : [];
    members.forEach(member => indexSlackMemberEmail(byEmail, member));
    cursor = String(data?.response_metadata?.next_cursor || '').trim();
    loops += 1;
  } while (cursor && loops < 50);

  slackUserDirectoryCache = {
    byEmail,
    expiresAt: now + SLACK_USER_DIRECTORY_TTL_MS,
  };
  return byEmail;
}

async function slackUserIdByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  if (slackUserByEmailCache.has(normalized)) {
    return slackUserByEmailCache.get(normalized);
  }

  try {
    const data = await callSlackFormApi('/api/users.lookupByEmail', { email: normalized });
    const userId = String(data?.user?.id || '');
    if (userId) slackUserByEmailCache.set(normalized, userId);
    if (userId) return userId;
  } catch {}

  try {
    const byEmail = await loadSlackUserDirectory();
    const userId = String(byEmail.get(normalized) || '').trim();
    if (userId) {
      slackUserByEmailCache.set(normalized, userId);
      return userId;
    }
  } catch {}

  return '';
}

function shouldRetrySlackLookup(reason = '') {
  const normalized = String(reason || '').toLowerCase();
  return (
    normalized.includes('slack_user_not_found')
    || normalized.includes('users_not_found')
    || normalized.includes('user_not_found')
  );
}

async function resolveSlackUserIdByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';

  let userId = await slackUserIdByEmail(normalized);
  if (userId) return userId;

  try {
    await loadSlackUserDirectory(true);
    userId = await slackUserIdByEmail(normalized);
  } catch {}

  return userId;
}

async function sendMessageToSlackUser(userId, message = {}) {
  if (!userId) return { sent: false, reason: 'slack_user_not_found' };
  const text = String(message?.text || '').trim();
  const blocks = Array.isArray(message?.blocks) ? message.blocks : [];

  try {
    let dmChannelId = '';
    try {
      dmChannelId = await openDmChannel(userId);
    } catch (error) {
      const reason = String(error?.message || '').toLowerCase();
      const canFallbackToUserId = (
        reason.includes('missing_scope')
        || reason.includes('not_allowed_token_type')
        || reason.includes('no_permission')
      );
      if (!canFallbackToUserId) throw error;
    }

    const payload = {
      channel: dmChannelId || userId,
      text,
      mrkdwn: 'true',
      unfurl_links: 'false',
      unfurl_media: 'false',
    };
    if (blocks.length) payload.blocks = JSON.stringify(blocks);

    await callSlackFormApi('/api/chat.postMessage', payload);
    return { sent: true, channelType: dmChannelId ? 'dm' : 'user' };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

async function openDmChannel(userId) {
  if (!userId) return '';
  const data = await callSlackFormApi('/api/conversations.open', { users: userId });
  return String(data?.channel?.id || '');
}

async function sendSlackInboxMessageByEmail(email, text) {
  const normalized = normalizeEmail(email);
  const message = normalizeSlackMessageInput(text);
  if (!normalized || !message.text) {
    return { sent: false, reason: 'missing_payload' };
  }

  const userId = await resolveSlackUserIdByEmail(normalized);
  const result = await sendMessageToSlackUser(userId, message);
  if (!result.sent && shouldRetrySlackLookup(result.reason || '')) {
    const refreshedUserId = await resolveSlackUserIdByEmail(normalized);
    return sendMessageToSlackUser(refreshedUserId, message);
  }
  return result;
}

module.exports = {
  sendSlackInboxMessageByEmail,
};
