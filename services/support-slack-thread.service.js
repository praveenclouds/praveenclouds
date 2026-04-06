const jwt = require('jsonwebtoken');
const { AppConnector } = require('../db');
const { JWT_SECRET } = require('../config');
const { apiPost } = require('../utils/http');
const { resolveSlackBotToken } = require('../utils/slack-token');

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
  if (normalized === 'in_progress') return 'In Progress';
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

function compact(value, max = 240) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function escapeMrkdwn(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatDateTime(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('en-IN');
}

function findStepByKey(checklist = [], key = '') {
  const target = String(key || '').trim();
  if (!target) return null;
  return (Array.isArray(checklist) ? checklist : []).find(step => String(step?.key || '').trim() === target) || null;
}

function nextCompletableStep(request = {}) {
  const steps = Array.isArray(request.checklist) ? request.checklist : [];
  for (const step of steps) {
    if (String(step?.status || 'pending') === 'done') continue;
    if (String(step?.approvalMode || 'none') === 'manager') continue;
    const dependencyKey = String(step?.dependsOn || '').trim();
    if (!dependencyKey) return step;
    const dependencyStep = findStepByKey(steps, dependencyKey);
    if (dependencyStep && String(dependencyStep.status || 'pending') !== 'done') continue;
    return step;
  }
  return null;
}

function buildTaskCompleteToken(request = {}, step = {}) {
  const requestId = request?._id?.toString?.() || request?.id || '';
  const requestItemKey = String(step?.key || '').trim();
  if (!requestId || !requestItemKey) return '';

  return jwt.sign(
    {
      kind: 'support_task_complete',
      requestId,
      requestItemKey,
      recipientEmail: '',
    },
    JWT_SECRET,
    { expiresIn: 60 * 60 * 24 * 7 }
  );
}

function buildCommentToken(request = {}) {
  const requestId = request?._id?.toString?.() || request?.id || '';
  if (!requestId) return '';
  return jwt.sign(
    {
      kind: 'support_request_add_comment',
      requestId,
    },
    JWT_SECRET,
    { expiresIn: 60 * 60 * 24 * 7 }
  );
}

function buildTrackingCard(request = {}) {
  const typeLabel = safe(request.workflowLabel || request.workflowType, 'Support Request');
  const title = `${safe(request.requestId)} • ${typeLabel}`;
  const employeeLine = `${safe(request.employeeName, '-')} (${safe(request.employeeEmail, '-')})`;
  const details = compact(request.notes, 320) || '-';
  const nextStep = nextCompletableStep(request);
  const completeToken = nextStep ? buildTaskCompleteToken(request, nextStep) : '';
  const commentToken = buildCommentToken(request);

  const fields = [
    `*Assignee*\n${escapeMrkdwn(safe(request.assignee, '-'))}`,
    `*Priority*\n${escapeMrkdwn(safe(request.priority, 'medium'))}`,
    `*Submitted by*\n${escapeMrkdwn(safe(request.requestedByName, '-'))}`,
    `*Date submitted*\n${escapeMrkdwn(formatDateTime(request.createdAt))}`,
    `*Employee*\n${escapeMrkdwn(employeeLine)}`,
    `*Department*\n${escapeMrkdwn(safe(request.department, '-'))}`,
    `*Status*\n${escapeMrkdwn(statusLabel(request.status))}`,
    `*Progress*\n${escapeMrkdwn(progressSummary(request))}`,
    `*Next step*\n${escapeMrkdwn(nextStep?.label || 'No actionable step')}`,
    `*Details*\n${escapeMrkdwn(details)}`,
  ].map(text => ({
    type: 'mrkdwn',
    text,
  }));

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(title)}*`,
      },
    },
    {
      type: 'section',
      fields,
    },
  ];

  const actionElements = [];
  if (completeToken) {
    actionElements.push({
      type: 'button',
      action_id: 'support_task_complete',
      style: 'primary',
      text: { type: 'plain_text', text: 'Mark Complete', emoji: true },
      value: completeToken,
    });
  }
  if (commentToken) {
    actionElements.push({
      type: 'button',
      action_id: 'support_request_add_comment',
      text: { type: 'plain_text', text: 'Add Comment', emoji: true },
      value: commentToken,
    });
  }
  if (actionElements.length) {
    blocks.push({
      type: 'actions',
      elements: actionElements,
    });
  }

  return {
    text: `${safe(request.requestId)} • ${statusLabel(request.status)} • ${progressSummary(request)}`,
    blocks,
  };
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
  return resolveSlackBotToken(connector.apiToken, { label: 'Slack Bot Token' });
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
  if (!data.ok) {
    const details = Array.isArray(data?.response_metadata?.messages)
      ? data.response_metadata.messages.join(' | ')
      : '';
    throw new Error([data.error || `Slack API call failed: ${path}`, details].filter(Boolean).join(' :: '));
  }
  return data;
}

async function postSlackMessage({ channel, text, blocks = [], threadTs = '' }) {
  const payload = {
    channel,
    text,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
  if (Array.isArray(blocks) && blocks.length) payload.blocks = blocks;
  if (threadTs) payload.thread_ts = threadTs;
  return callSlackApi('/api/chat.postMessage', payload);
}

async function updateSlackMessage({ channel, ts, text, blocks = [] }) {
  const payload = {
    channel,
    ts,
    text,
    blocks,
    mrkdwn: true,
    unfurl_links: false,
    unfurl_media: false,
  };
  return callSlackApi('/api/chat.update', payload);
}

async function postSupportRequestCreatedMessage(request) {
  const current = asObject(request);
  const channel = String(current.slackChannelId || '').trim();
  if (!channel) return { posted: false, reason: 'missing_channel_context' };

  try {
    const card = buildTrackingCard(current);
    const result = await postSlackMessage({
      channel,
      text: card.text,
      blocks: card.blocks,
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
  const rootMessageTs = String(current.slackMessageTs || threadTs).trim();
  if (!channel) return { posted: false, reason: 'missing_channel_context' };
  const summaryText = buildUpdatedMessage(previous, current, meta);
  const eventText = compact(meta.eventText || summaryText, 280);
  const forceRefresh = !!meta.forceRefresh;
  const shouldRefresh = forceRefresh || !!summaryText;
  if (!shouldRefresh) return { posted: false, reason: 'no_relevant_status_change' };

  try {
    const card = buildTrackingCard(current);
    let resolvedRootTs = rootMessageTs;

    if (resolvedRootTs) {
      await updateSlackMessage({
        channel,
        ts: resolvedRootTs,
        text: card.text,
        blocks: card.blocks,
      });
    } else {
      const rootPost = await postSlackMessage({
        channel,
        text: card.text,
        blocks: card.blocks,
      });
      resolvedRootTs = String(rootPost.ts || '');
    }

    const resolvedThreadTs = String(threadTs || resolvedRootTs || '');
    let messageTs = resolvedRootTs;
    if (eventText && resolvedThreadTs) {
      const eventPost = await postSlackMessage({
        channel,
        threadTs: resolvedThreadTs,
        text: eventText,
      });
      messageTs = String(eventPost.ts || messageTs || '');
    }

    return {
      posted: true,
      channelId: channel,
      messageTs,
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
