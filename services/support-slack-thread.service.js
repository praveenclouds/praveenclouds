const { AppConnector } = require('../db');
const { apiPost } = require('../utils/http');

function asObject(request = {}) {
  return request?.toObject ? request.toObject() : { ...(request || {}) };
}

function safe(value, fallback = '-') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function statusLabel(status = '') {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return 'Open';
  if (normalized === 'in_progress') return 'Inprogress';
  if (normalized === 'completed') return 'Completed';
  if (normalized === 'blocked') return 'Blocked';
  if (normalized === 'cancelled') return 'Cancelled';
  if (normalized === 'open') return 'Open';
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function isCompleted(request = {}) {
  const status = String(request.status || '').trim().toLowerCase();
  if (status === 'completed') return true;
  const steps = Array.isArray(request.checklist) ? request.checklist : [];
  if (!steps.length) return false;
  return steps.every(step => step.status === 'done');
}

function progressSummary(request = {}) {
  const steps = Array.isArray(request.checklist) ? request.checklist : [];
  const total = steps.length;
  const done = steps.filter(step => step.status === 'done').length;
  const percent = total ? Math.round((done / total) * 100) : 0;
  return `${done}/${total} (${percent}%)`;
}

function buildCreatedMessage(request = {}) {
  const employeeName = safe(request.employeeName, '-');
  const employeeEmail = safe(request.employeeEmail, '-');
  return [
    `[Support] New request created: ${safe(request.requestId)}`,
    `Type: ${safe(request.workflowLabel || request.workflowType, 'Support Request')}`,
    `Employee: ${employeeName} (${employeeEmail})`,
    `Priority: ${safe(request.priority, 'medium')}`,
    `Status: ${safe(request.status, 'open')}`,
    `Progress: ${progressSummary(request)}`,
    `Requested by: ${safe(request.requestedByName, '-')}`,
  ].join('\n');
}

function buildUpdatedMessage(previousRequest = {}, currentRequest = {}) {
  const prevCompleted = isCompleted(previousRequest);
  const nowCompleted = isCompleted(currentRequest);
  if (!prevCompleted && nowCompleted) {
    const requestName = safe(currentRequest.employeeName, currentRequest.requestId);
    return `"${requestName}" your request has been completed`;
  }

  const previousStatus = String(previousRequest.status || '').trim();
  const currentStatus = String(currentRequest.status || '').trim();
  if (previousStatus !== currentStatus && currentStatus) {
    return `Status -> ${statusLabel(currentStatus)}`;
  }

  return '';
}

async function getSlackBotToken() {
  const connector = await AppConnector.findOne({ appName: 'slack' }).lean();
  if (!connector?.apiToken) throw new Error('Slack Bot Token is not configured.');
  return connector.apiToken;
}

async function callSlackApi(path, body) {
  const token = await getSlackBotToken();
  const raw = await apiPost(
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

async function postSlackMessage({ channel, text, threadTs = '' }) {
  const payload = {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (threadTs) payload.thread_ts = threadTs;
  return callSlackApi('/api/chat.postMessage', payload);
}

async function postSupportRequestCreatedMessage(request) {
  const current = asObject(request);
  const channel = String(current.slackChannelId || '').trim();
  if (!channel) return { posted: false, reason: 'missing_channel_context' };

  try {
    const result = await postSlackMessage({
      channel,
      text: buildCreatedMessage(current),
    });
    return {
      posted: true,
      channelId: channel,
      messageTs: String(result.ts || ''),
      threadTs: String(result.thread_ts || result.ts || ''),
    };
  } catch (error) {
    console.error('[support slack] create message failed:', error.message);
    return { posted: false, reason: error.message };
  }
}

async function postSupportRequestUpdateMessage(previousRequest, currentRequest, meta = {}) {
  const previous = asObject(previousRequest);
  const current = asObject(currentRequest);
  const channel = String(current.slackChannelId || '').trim();
  const threadTs = String(current.slackThreadTs || current.slackMessageTs || '').trim();
  if (!channel) return { posted: false, reason: 'missing_channel_context' };
  const text = buildUpdatedMessage(previous, current, meta);
  if (!text) return { posted: false, reason: 'no_relevant_status_change' };

  try {
    const result = await postSlackMessage({
      channel,
      threadTs: threadTs || '',
      text,
    });
    const resolvedThreadTs = String(result.thread_ts || result.ts || threadTs || '');
    return {
      posted: true,
      channelId: channel,
      messageTs: String(result.ts || ''),
      threadTs: resolvedThreadTs,
    };
  } catch (error) {
    console.error('[support slack] update message failed:', error.message);
    return { posted: false, reason: error.message };
  }
}

module.exports = {
  postSupportRequestCreatedMessage,
  postSupportRequestUpdateMessage,
};
