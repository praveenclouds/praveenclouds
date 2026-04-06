const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Software, SupportRequest, SupportRequestType } = require('../db');
const { JWT_SECRET } = require('../config');
const { loadEmailSettings, sendMail } = require('./email.service');
const { renderSupportMailTemplate } = require('./support-mail-template.service');
const { loadUserDirectory, softwareOwnerCandidates } = require('./support-request.service');
const { logSupportSlaEvent } = require('./support-log.service');
const { sendSlackInboxMessageByEmail } = require('./slack-inbox.service');

const DEFAULT_SLA_POLICY = SupportRequestType?.DEFAULT_SLA_POLICY || {
  enabled: true,
  responseMinutes: 60,
  resolutionMinutes: 480,
  atRiskPercent: 80,
  priorityResponseMinutes: { low: 120, medium: 60, high: 30 },
  priorityResolutionMinutes: { low: 120, medium: 60, high: 30 },
  breachReminderMinutes: 10,
  notifyAtRisk: true,
  notifyOnBreach: true,
  autoEscalateOnBreach: true,
};

const normalizePriority = SupportRequestType?.normalizePriority
  || (value => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'critical') return 'high';
    return ['low', 'medium', 'high'].includes(normalized) ? normalized : 'medium';
  });

const getSlaMinutesForPriority = SupportRequestType?.getSlaMinutesForPriority
  || ((policy = {}, priority = 'medium', kind = 'resolution') => {
    const normalized = normalizePriority(priority);
    if (kind === 'response') {
      return Number(policy?.priorityResponseMinutes?.[normalized] || policy?.responseMinutes || 60);
    }
    return Number(policy?.priorityResolutionMinutes?.[normalized] || policy?.resolutionMinutes || 480);
  });

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function requestDetailUrl(baseUrl) {
  return `${baseUrl}/support`;
}

function approvalActionUrl(baseUrl, token, decision) {
  const params = new URLSearchParams({ token, decision });
  return `${baseUrl}/api/support/approval-action?${params.toString()}`;
}

function personChanged(before = {}, after = {}) {
  return (
    String(before.userId || '') !== String(after.userId || '')
    || String(before.email || '').toLowerCase() !== String(after.email || '').toLowerCase()
    || String(before.name || '') !== String(after.name || '')
  );
}

function taskMap(checklist = []) {
  return new Map((checklist || []).map(item => [item.key, item]));
}

function normalizeStepKey(step = {}) {
  return String(step?.key || '').trim();
}

function dependencySatisfied(step = {}, checklist = []) {
  const steps = Array.isArray(checklist) ? checklist : [];
  let dependencyKey = String(step?.dependsOn || '').trim();
  if (!dependencyKey) {
    const currentStepKey = normalizeStepKey(step);
    const currentIndex = currentStepKey
      ? steps.findIndex(item => normalizeStepKey(item) === currentStepKey)
      : -1;
    if (currentIndex > 0) {
      dependencyKey = normalizeStepKey(steps[currentIndex - 1]);
    }
  }
  if (!dependencyKey) return true;
  const dependencyStep = steps.find(item => normalizeStepKey(item) === dependencyKey);
  if (!dependencyStep) return true;
  return String(dependencyStep.status || 'pending') === 'done';
}

function fallbackValue(value, fallback = '—') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
}

function compactNotes(value, max = 500) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function formatRequestedApplications(request = {}, max = 6) {
  const rows = Array.isArray(request?.applications) ? request.applications : [];
  const names = rows
    .map((app) => (typeof app === 'string' ? app : app?.name))
    .map((v) => String(v || '').trim())
    .filter(Boolean);
  const unique = [...new Set(names)];
  if (!unique.length) return '—';
  if (unique.length <= max) return unique.join(', ');
  return `${unique.slice(0, max).join(', ')} +${unique.length - max} more`;
}

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function sameDateValue(left, right) {
  const a = toDateOrNull(left);
  const b = toDateOrNull(right);
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.getTime() === b.getTime();
}

function clampMinutes(value, fallback = 10, min = 1, max = 43200) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function normalizeSlaPolicySnapshot(input = {}) {
  if (typeof SupportRequestType?.normalizeSlaPolicy === 'function') {
    return SupportRequestType.normalizeSlaPolicy(input, DEFAULT_SLA_POLICY);
  }
  return { ...DEFAULT_SLA_POLICY, ...(input || {}) };
}

function hasChecklistProgress(checklist = []) {
  return (Array.isArray(checklist) ? checklist : []).some(item => String(item?.status || '') === 'done');
}

function evaluateRequestSla(request = {}, now = new Date()) {
  const policy = normalizeSlaPolicySnapshot(request?.slaPolicySnapshot || {});
  const status = String(request?.status || '').trim().toLowerCase();
  const createdAt = toDateOrNull(request?.createdAt) || now;
  const priority = normalizePriority(request?.priority);
  let firstResponseAt = toDateOrNull(request?.firstResponseAt);

  if (!firstResponseAt) {
    const hasRespondedStatus = ['in_progress', 'blocked', 'completed'].includes(status);
    if (hasRespondedStatus || hasChecklistProgress(request?.checklist || [])) {
      firstResponseAt = now;
    }
  }

  const resolvedAt = status === 'completed'
    ? (toDateOrNull(request?.resolvedAt) || now)
    : null;

  if (!policy.enabled) {
    return {
      policy,
      firstResponseAt,
      resolvedAt,
      responseDueAt: null,
      resolutionDueAt: null,
      slaStatus: 'no_sla',
      breachedAt: null,
    };
  }

  const responseMinutes = clampMinutes(
    getSlaMinutesForPriority(policy, priority, 'response'),
    clampMinutes(policy.responseMinutes, 60)
  );
  const resolutionMinutes = clampMinutes(
    getSlaMinutesForPriority(policy, priority, 'resolution'),
    clampMinutes(policy.resolutionMinutes, 480)
  );
  const responseDueAt = new Date(createdAt.getTime() + (responseMinutes * 60 * 1000));
  const resolutionDueAt = new Date(createdAt.getTime() + (resolutionMinutes * 60 * 1000));

  let slaStatus = 'on_track';
  if (status === 'cancelled') {
    slaStatus = 'paused';
  } else if (status === 'completed') {
    const completedAt = resolvedAt || now;
    slaStatus = completedAt.getTime() > resolutionDueAt.getTime() ? 'breached' : 'met';
  } else if ((!firstResponseAt && now.getTime() > responseDueAt.getTime()) || now.getTime() > resolutionDueAt.getTime()) {
    slaStatus = 'breached';
  } else {
    const totalMs = resolutionDueAt.getTime() - createdAt.getTime();
    const elapsedMs = now.getTime() - createdAt.getTime();
    const elapsedPercent = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
    slaStatus = elapsedPercent >= Number(policy.atRiskPercent || 80) ? 'at_risk' : 'on_track';
  }

  return {
    policy,
    firstResponseAt,
    resolvedAt,
    responseDueAt,
    resolutionDueAt,
    slaStatus,
    breachedAt: slaStatus === 'breached'
      ? (toDateOrNull(request?.slaBreachedAt) || now)
      : null,
  };
}

function applySlaSnapshotToRequest(request, snapshot = {}) {
  if (!request || !snapshot || typeof snapshot !== 'object') return;

  const nextPolicyJson = JSON.stringify(snapshot.policy || {});
  const currentPolicyJson = JSON.stringify(request.slaPolicySnapshot || {});
  if (nextPolicyJson !== currentPolicyJson) {
    request.slaPolicySnapshot = snapshot.policy;
  }

  if (!sameDateValue(request.firstResponseAt, snapshot.firstResponseAt)) {
    request.firstResponseAt = snapshot.firstResponseAt;
  }
  if (!sameDateValue(request.resolvedAt, snapshot.resolvedAt)) {
    request.resolvedAt = snapshot.resolvedAt;
  }
  if (!sameDateValue(request.slaResponseDueAt, snapshot.responseDueAt)) {
    request.slaResponseDueAt = snapshot.responseDueAt;
  }
  if (!sameDateValue(request.slaResolutionDueAt, snapshot.resolutionDueAt)) {
    request.slaResolutionDueAt = snapshot.resolutionDueAt;
  }
  if (!sameDateValue(request.slaBreachedAt, snapshot.breachedAt)) {
    request.slaBreachedAt = snapshot.breachedAt;
  }
  if (String(request.slaStatus || '') !== String(snapshot.slaStatus || '')) {
    request.slaStatus = snapshot.slaStatus;
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bodyToHtml(body) {
  return String(body || '')
    .split(/\n{2,}/)
    .map(block => block.trim())
    .filter(Boolean)
    .map(block => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function templateContext(request = {}, extra = {}) {
  return {
    requestId: fallbackValue(request.requestId, ''),
    workflowLabel: fallbackValue(request.workflowLabel || request.workflowType, 'Support Request'),
    workflowType: fallbackValue(request.workflowType, ''),
    employeeName: fallbackValue(request.employeeName, 'Employee'),
    employeeEmail: fallbackValue(request.employeeEmail),
    department: fallbackValue(request.department),
    priority: fallbackValue(request.priority),
    requestedByName: fallbackValue(request.requestedByName, 'Unknown requester'),
    assignee: fallbackValue(request.assignee),
    managerName: fallbackValue(request.managerName),
    applications: (request.applications || []).map(app => app?.name).filter(Boolean).join(', ') || '—',
    stepLabel: fallbackValue(extra.stepLabel, ''),
    handoffMessage: fallbackValue(extra.handoffMessage, ''),
    detailUrl: extra.detailUrl || '',
    approveUrl: extra.approveUrl || '',
    rejectUrl: extra.rejectUrl || '',
  };
}

async function sendAssignmentEmail({ to, templateKey, request, stepLabel = '', handoffMessage = '' }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) return;
  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const rendered = await renderSupportMailTemplate(templateKey, templateContext(request, { stepLabel, handoffMessage, detailUrl }));
  const actionLabel = rendered.ctaLabel || 'Open Support Center';
  const handoffBlock = String(handoffMessage || '').trim();
  await sendMail({
    to: recipients,
    subject: rendered.subject,
    text: [
      rendered.intro,
      rendered.body,
      handoffBlock ? `Handoff message from previous step:\n${handoffBlock}` : '',
      detailUrl ? `${actionLabel}: ${detailUrl}` : '',
      rendered.footerNote,
    ].filter(Boolean).join('\n\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        ${rendered.intro ? `<p>${escapeHtml(rendered.intro)}</p>` : ''}
        ${bodyToHtml(rendered.body)}
        ${handoffBlock ? `<p><strong>Handoff message from previous step:</strong><br>${escapeHtml(handoffBlock).replace(/\n/g, '<br>')}</p>` : ''}
        ${detailUrl ? `<p><a href="${escapeHtml(detailUrl)}" style="display:inline-block;padding:10px 16px;background:#3757e6;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(actionLabel)}</a></p>` : ''}
        ${rendered.footerNote ? `<p style="font-size:12px;color:#6b7280">${escapeHtml(rendered.footerNote)}</p>` : ''}
      </div>
    `,
  });
}

function buildAssigneeSlackMessage(request, detailUrl) {
  const notes = compactNotes(request.notes);
  const requestId = fallbackValue(request.requestId, '-');
  const requestType = fallbackValue(request.workflowLabel || request.workflowType, 'Support Request');
  const employee = fallbackValue(request.employeeName, '-');
  const employeeEmail = fallbackValue(request.employeeEmail, '-');
  const priority = humanizeLabel(request.priority, '-');
  const currentStatus = humanizeLabel(request.status, '-');
  const text = `Support assignment • ${requestId} • ${requestType}`;
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*📌 Support Request Assigned*\nPlease take ownership of this request.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Request:* \`${requestId}\`  •  *Type:* ${requestType}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Employee*\n${employee}` },
        { type: 'mrkdwn', text: `*Email*\n${employeeEmail}` },
        { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Current Status*\n${currentStatus}` },
      ],
    },
  ];
  if (notes) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Notes: ${notes}` }],
    });
  }
  if (detailUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Support Center', emoji: true },
          style: 'primary',
          url: detailUrl,
        },
      ],
    });
  }
  return { text, blocks };
}

function buildTaskAssignmentSlackMessage(request, step = {}, detailUrl, completeToken = '', handoffMessage = '') {
  const stepLabel = step?.label || '';
  const notes = compactNotes(request.notes);
  const requestId = fallbackValue(request.requestId, '-');
  const requestType = fallbackValue(request.workflowLabel || request.workflowType, 'Support Request');
  const task = fallbackValue(stepLabel, '-');
  const employee = fallbackValue(request.employeeName, '-');
  const employeeEmail = fallbackValue(request.employeeEmail, '-');
  const priority = humanizeLabel(request.priority, '-');
  const currentStatus = humanizeLabel(request.status, '-');
  const handoffText = String(handoffMessage || '').trim();
  const text = `Workflow task assigned • ${requestId} • ${task}`;
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*🧩 Workflow Task Assigned*\nA checklist task is ready for your action.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Request:* \`${requestId}\`  •  *Type:* ${requestType}\n*Task:* ${task}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Employee*\n${employee}` },
        { type: 'mrkdwn', text: `*Email*\n${employeeEmail}` },
        { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Current Status*\n${currentStatus}` },
      ],
    },
  ];
  if (notes) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Notes: ${notes}` }],
    });
  }
  if (handoffText) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Handoff message from previous step*\n${escapeMrkdwn(handoffText)}` },
    });
  }

  const actionButtons = [];
  if (completeToken) {
    actionButtons.push({
      type: 'button',
      action_id: 'support_task_complete',
      style: 'primary',
      text: { type: 'plain_text', text: 'Step completed', emoji: true },
      value: completeToken,
    });
  }
  if (detailUrl) {
    actionButtons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Open Support Center', emoji: true },
      url: detailUrl,
    });
  }
  if (actionButtons.length) {
    blocks.push({
      type: 'actions',
      elements: actionButtons,
    });
  }

  return { text, blocks };
}

function buildManagerApprovalSlackMessage(request, step, approveUrl, rejectUrl) {
  const notes = compactNotes(request.notes);
  const requestId = fallbackValue(request.requestId, '-');
  const requestType = fallbackValue(request.workflowLabel || request.workflowType, 'Support Request');
  const approvalStep = fallbackValue(step?.label, '-');
  const employee = fallbackValue(request.employeeName, '-');
  const employeeEmail = fallbackValue(request.employeeEmail, '-');
  const priority = humanizeLabel(request.priority, '-');
  const applications = formatRequestedApplications(request);
  const text = `Manager approval needed • ${requestId} • ${approvalStep}`;
  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: '*✅ Manager Approval Needed*\nPlease review and choose an action.',
      },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Request:* \`${requestId}\`  •  *Type:* ${requestType}\n*Approval Step:* ${approvalStep}`,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Employee*\n${employee}` },
        { type: 'mrkdwn', text: `*Email*\n${employeeEmail}` },
        { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Applications*\n${applications}` },
      ],
    },
  ];
  if (notes) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `Notes: ${notes}` }],
    });
  }

  const elements = [];
  if (approveUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Approve', emoji: true },
      style: 'primary',
      url: approveUrl,
    });
  }
  if (rejectUrl) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Reject', emoji: true },
      style: 'danger',
      url: rejectUrl,
    });
  }
  if (elements.length) {
    blocks.push({
      type: 'actions',
      elements,
    });
  }

  return { text, blocks };
}

function uniqueEmails(people = []) {
  const seen = new Set();
  return (people || [])
    .map(person => String(person?.email || '').trim().toLowerCase())
    .filter(Boolean)
    .filter(email => {
      if (seen.has(email)) return false;
      seen.add(email);
      return true;
    });
}

function resolvePersonWithDirectory(person = {}, userDirectory = null) {
  const userId = String(person?.userId || person?.id || '').trim();
  const email = String(person?.email || '').trim().toLowerCase();
  const name = String(person?.name || '').trim();

  const matched = userDirectory
    ? (
      (userId && userDirectory.byId.get(userId))
      || (email && userDirectory.byEmail.get(email))
      || (name && userDirectory.byName.get(name.toLowerCase()))
    )
    : null;

  return {
    userId: userId || String(matched?.userId || '').trim(),
    email: email || String(matched?.email || '').trim().toLowerCase(),
    name: name || String(matched?.name || '').trim(),
  };
}

async function sendManagerApprovalEmail(request, step, token) {
  if (!request?.managerEmail) return false;
  const settings = await loadEmailSettings();
  const approveUrl = approvalActionUrl(settings.appBaseUrl, token, 'approve');
  const rejectUrl = approvalActionUrl(settings.appBaseUrl, token, 'reject');
  const rendered = await renderSupportMailTemplate('manager_approval', templateContext(request, {
    stepLabel: step.label,
    approveUrl,
    rejectUrl,
  }));
  const approveLabel = rendered.ctaLabel || 'Approve';
  const rejectLabel = rendered.secondaryCtaLabel || 'Reject';

  const result = await sendMail({
    to: request.managerEmail,
    subject: rendered.subject,
    text: [
      rendered.intro,
      rendered.body,
      `${approveLabel}: ${approveUrl}`,
      `${rejectLabel}: ${rejectUrl}`,
      rendered.footerNote,
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        ${rendered.intro ? `<p>${escapeHtml(rendered.intro)}</p>` : ''}
        ${bodyToHtml(rendered.body)}
        <p style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="${escapeHtml(approveUrl)}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(approveLabel)}</a>
          <a href="${escapeHtml(rejectUrl)}" style="display:inline-block;padding:10px 16px;background:#dc2626;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(rejectLabel)}</a>
        </p>
        ${rendered.footerNote ? `<p style="font-size:12px;color:#6b7280">${escapeHtml(rendered.footerNote)}</p>` : ''}
      </div>
    `,
  });

  return !!result.ok;
}

async function sendAssigneeSlackInboxMessage(request, assigneeEmail) {
  const recipient = String(assigneeEmail || '').trim().toLowerCase();
  if (!recipient) return { sent: false, reason: 'missing_assignee_email' };

  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  return sendSlackInboxMessageByEmail(
    recipient,
    buildAssigneeSlackMessage(request, detailUrl)
  );
}

async function sendManagerApprovalSlackInboxMessage(request, step, token) {
  if (!request?.managerEmail) return false;

  const settings = await loadEmailSettings();
  const approveUrl = approvalActionUrl(settings.appBaseUrl, token, 'approve');
  const rejectUrl = approvalActionUrl(settings.appBaseUrl, token, 'reject');
  const result = await sendSlackInboxMessageByEmail(
    request.managerEmail,
    buildManagerApprovalSlackMessage(request, step, approveUrl, rejectUrl)
  );
  return !!result.sent;
}

function buildTaskCompleteToken(request = {}, step = {}, recipientEmail = '') {
  const requestId = request?._id?.toString?.() || request?.id || '';
  const requestItemKey = String(step?.key || '').trim();
  if (!requestId || !requestItemKey) return '';

  return jwt.sign(
    {
      kind: 'support_task_complete',
      requestId,
      requestItemKey,
      recipientEmail: String(recipientEmail || '').trim().toLowerCase(),
    },
    JWT_SECRET,
    { expiresIn: 60 * 60 * 24 * 7 }
  );
}

async function sendTaskAssigneeSlackInboxMessages(request, step = {}, recipients = [], options = {}) {
  const targetEmails = uniqueEmails((recipients || []).map(email => ({ email })));
  if (!targetEmails.length) return false;

  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const canAddCompleteButton = (
    String(step?.approvalMode || 'none') !== 'manager'
    && String(step?.status || 'pending') !== 'done'
  );
  const handoffMessage = String(options.handoffMessage || '').trim();
  const results = await Promise.all(targetEmails.map(email => {
    const completeToken = canAddCompleteButton ? buildTaskCompleteToken(request, step, email) : '';
    const message = buildTaskAssignmentSlackMessage(request, step, detailUrl, completeToken, handoffMessage);
    return sendSlackInboxMessageByEmail(email, message);
  }));
  return results.some(result => result?.sent);
}

function formatSlaDateTime(value) {
  const date = toDateOrNull(value);
  if (!date) return '—';
  return date.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function humanizeLabel(value, fallback = '—') {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildSlaSlackMessage(request = {}, detailUrl = '', context = {}) {
  const event = String(context.event || 'alert').trim().toLowerCase();
  const headingMap = {
    at_risk: '⚠️ SLA At-Risk Alert',
    breach: '🚨 SLA Breach Alert',
    reminder: '🔁 SLA Breach Reminder',
    escalation: '⬆️ SLA Escalation Triggered',
  };
  const heading = headingMap[event] || 'ℹ️ SLA Alert';
  const responseDueAt = formatSlaDateTime(request?.slaResponseDueAt);
  const resolutionDueAt = formatSlaDateTime(request?.slaResolutionDueAt);
  const reminderMinutes = clampMinutes(context.reminderMinutes, 10, 1, 1440);
  const includeDueDates = event !== 'reminder';
  const requestId = fallbackValue(request.requestId, '-');
  const requestType = fallbackValue(request.workflowLabel || request.workflowType, 'Support Request');
  const priority = humanizeLabel(request.priority, '-');
  const currentStatus = humanizeLabel(request.status, '-');
  const slaStatus = humanizeLabel(request.slaStatus, '-');

  const summaryText = [
    heading,
    `Request ${requestId}`,
    `${requestType}`,
    `Priority ${priority}`,
    `Status ${currentStatus}`,
    `SLA ${slaStatus}`,
    ...(includeDueDates ? [`Resolution due ${resolutionDueAt}`] : []),
  ].join(' • ');

  const blocks = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${heading}*\n*Request:* \`${requestId}\`  •  *Type:* ${requestType}`,
      },
    },
    {
      type: 'section',
      fields: (
        [
        { type: 'mrkdwn', text: `*Priority*\n${priority}` },
        { type: 'mrkdwn', text: `*Current Status*\n${currentStatus}` },
        { type: 'mrkdwn', text: `*SLA Status*\n${slaStatus}` },
        ]
          .concat(includeDueDates ? [
            { type: 'mrkdwn', text: `*Response Due*\n${responseDueAt}` },
            { type: 'mrkdwn', text: `*Resolution Due*\n${resolutionDueAt}` },
          ] : [])
      ),
    },
  ];

  if (event === 'reminder') {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Reminder cadence: every *${reminderMinutes} minute(s)* until the request is completed.`,
      }],
    });
  }
  if (context.escalationTarget) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `Escalated to: *${fallbackValue(context.escalationTarget, '-') }*`,
      }],
    });
  }

  if (detailUrl) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Open Support Center', emoji: true },
          style: 'primary',
          url: detailUrl,
        },
      ],
    });
  }

  return { text: summaryText, blocks };
}

async function sendSlaEmail(recipients = [], request = {}, context = {}) {
  const to = uniqueEmails((recipients || []).map(email => ({ email })));
  if (!to.length) return false;

  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const event = String(context.event || 'alert').trim().toLowerCase();
  const eventLabel = (
    event === 'at_risk' ? 'At Risk'
      : event === 'breach' ? 'Breached'
        : event === 'reminder' ? 'Reminder'
          : event === 'escalation' ? 'Escalated'
            : 'Alert'
  );

  const subject = `[Support SLA ${eventLabel}] ${fallbackValue(request.requestId, 'Support Request')} • ${fallbackValue(request.workflowLabel || request.workflowType, 'Support Request')}`;
  const summaryLines = [
    `Request: ${fallbackValue(request.requestId, '-')}`,
    `Type: ${fallbackValue(request.workflowLabel || request.workflowType, 'Support Request')}`,
    `Priority: ${fallbackValue(request.priority, '-')}`,
    `Status: ${fallbackValue(request.status, '-')}`,
    `SLA Status: ${fallbackValue(request.slaStatus, '-')}`,
    `Response Due: ${formatSlaDateTime(request?.slaResponseDueAt)}`,
    `Resolution Due: ${formatSlaDateTime(request?.slaResolutionDueAt)}`,
    detailUrl ? `Open Support Center: ${detailUrl}` : '',
  ].filter(Boolean);

  const result = await sendMail({
    to,
    subject,
    text: summaryLines.join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        <p style="font-weight:700;margin:0 0 12px">Support SLA ${escapeHtml(eventLabel)}</p>
        <p style="margin:0 0 12px">${summaryLines.map(line => escapeHtml(line)).join('<br>')}</p>
        ${detailUrl ? `<p style="margin:14px 0 0"><a href="${escapeHtml(detailUrl)}" style="display:inline-block;padding:10px 16px;background:#3757e6;color:#fff;text-decoration:none;border-radius:8px">Open Support Center</a></p>` : ''}
      </div>
    `,
  });
  return !!result?.ok;
}

async function sendSlaSlackDm(request = {}, recipientEmail = '', context = {}) {
  const email = String(recipientEmail || '').trim().toLowerCase();
  if (!email) return { sent: false, reason: 'missing_email' };
  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const message = buildSlaSlackMessage(request, detailUrl, context);
  return sendSlackInboxMessageByEmail(email, message);
}

async function notifyAssigneeSla(request = {}, recipientEmail = '', context = {}) {
  const email = String(recipientEmail || '').trim().toLowerCase();
  if (!email) return { emailSent: false, slackSent: false };
  const [emailSent, slackResult] = await Promise.all([
    sendSlaEmail([email], request, context),
    sendSlaSlackDm(request, email, context),
  ]);
  return { emailSent, slackSent: !!slackResult?.sent };
}

function shouldTrackSla(request = {}, policy = {}) {
  if (!policy || policy.enabled === false) return false;
  const status = String(request?.status || '').trim().toLowerCase();
  return !['completed', 'cancelled'].includes(status);
}

function canSendReminder(lastSentAt, reminderMinutes, now) {
  const intervalMs = clampMinutes(reminderMinutes, 10, 1, 1440) * 60 * 1000;
  const baseline = toDateOrNull(lastSentAt);
  if (!baseline) return true;
  return (now.getTime() - baseline.getTime()) >= intervalMs;
}

function resolveSlaNotificationPeople(request = {}, userDirectory = null) {
  const assignee = resolvePersonWithDirectory({
    userId: request.assigneeUserId,
    email: request.assigneeEmail,
    name: request.assignee,
  }, userDirectory);
  const manager = resolvePersonWithDirectory({
    userId: request.managerUserId,
    email: request.managerEmail,
    name: request.managerName,
  }, userDirectory);
  const requester = resolvePersonWithDirectory({
    userId: request.requestedById,
    email: request.requestedByEmail,
    name: request.requestedByName,
  }, userDirectory);

  if (!request.assignee && assignee.name) request.assignee = assignee.name;
  if (!request.assigneeUserId && assignee.userId) request.assigneeUserId = assignee.userId;
  if (!request.assigneeEmail && assignee.email) request.assigneeEmail = assignee.email;
  if (!request.managerName && manager.name) request.managerName = manager.name;
  if (!request.managerUserId && manager.userId) request.managerUserId = manager.userId;
  if (!request.managerEmail && manager.email) request.managerEmail = manager.email;

  return { assignee, manager, requester };
}

async function triggerSlaEscalation(request = {}, people = {}, options = {}) {
  const now = options.now || new Date();
  if (toDateOrNull(request.slaEscalatedAt)) return { escalated: false };

  const escalationTarget = people?.manager || {};
  const currentAssignee = people?.assignee || {};
  let reassigned = false;

  if (escalationTarget.email && escalationTarget.email !== currentAssignee.email) {
    request.assignee = escalationTarget.name || request.assignee || '';
    request.assigneeUserId = escalationTarget.userId || '';
    request.assigneeEmail = escalationTarget.email || '';
    reassigned = true;
  }

  request.slaEscalatedAt = now;
  const line = `[SLA escalation] ${now.toLocaleString('en-IN')} • Request breached SLA${reassigned ? ` • reassigned to ${request.assignee || request.assigneeEmail}` : ''}`;
  request.notes = `${String(request.notes || '').trim()}${request.notes ? '\n' : ''}${line}`.trim();

  const escalationRecipients = uniqueEmails([
    { email: request.assigneeEmail },
    { email: request.managerEmail },
    { email: request.requestedByEmail },
  ]);

  await sendSlaEmail(escalationRecipients, request, { event: 'escalation' });
  if (request.assigneeEmail) {
    await sendSlaSlackDm(request, request.assigneeEmail, {
      event: 'escalation',
      escalationTarget: request.assignee || request.assigneeEmail,
    });
  }

  await logSupportSlaEvent({
    request,
    source: options.source || 'sla_monitor',
    label: reassigned ? 'SLA escalated and reassigned' : 'SLA escalated',
    changes: [
      { field: 'SLA Status', oldValue: 'breached', newValue: 'breached' },
      { field: 'Escalated At', oldValue: '—', newValue: formatSlaDateTime(now) },
      ...(reassigned ? [{ field: 'Assignee', oldValue: currentAssignee.name || currentAssignee.email || 'Unassigned', newValue: request.assignee || request.assigneeEmail || 'Unassigned' }] : []),
    ],
  });

  return { escalated: true };
}

async function processSlaNotifications(previousRequest, currentRequest, options = {}) {
  if (!currentRequest) return { alertsSent: 0, remindersSent: 0, escalations: 0 };
  const now = options.now || new Date();
  const source = options.source || 'support_center';
  const policy = normalizeSlaPolicySnapshot(currentRequest.slaPolicySnapshot || {});
  const allowReminder = options.allowReminder !== false;
  if (!shouldTrackSla(currentRequest, policy)) return { alertsSent: 0, remindersSent: 0, escalations: 0 };

  const previousSlaStatus = String(previousRequest?.slaStatus || '').trim();
  const currentSlaStatus = String(currentRequest.slaStatus || '').trim();
  const people = resolveSlaNotificationPeople(currentRequest, options.userDirectory || null);

  let alertsSent = 0;
  let remindersSent = 0;
  let escalations = 0;

  const assigneeEmail = String(people?.assignee?.email || currentRequest.assigneeEmail || '').trim().toLowerCase();

  if (
    currentSlaStatus === 'at_risk'
    && policy.notifyAtRisk !== false
    && !toDateOrNull(currentRequest.slaNotifiedAtRiskAt)
    && assigneeEmail
  ) {
    const atRiskResult = await notifyAssigneeSla(currentRequest, assigneeEmail, { event: 'at_risk' });
    if (atRiskResult.emailSent || atRiskResult.slackSent) {
      currentRequest.slaNotifiedAtRiskAt = now;
      alertsSent += 1;
      await logSupportSlaEvent({
        request: currentRequest,
        source,
        label: 'SLA at-risk notification sent',
        changes: [
          { field: 'SLA Status', oldValue: previousSlaStatus || '—', newValue: currentSlaStatus || '—' },
          { field: 'Notified Assignee', oldValue: '—', newValue: assigneeEmail },
        ],
      });
    }
  }

  if (
    currentSlaStatus === 'breached'
    && policy.notifyOnBreach !== false
    && !toDateOrNull(currentRequest.slaNotifiedBreachAt)
    && assigneeEmail
  ) {
    const breachResult = await notifyAssigneeSla(currentRequest, assigneeEmail, { event: 'breach' });
    if (breachResult.emailSent || breachResult.slackSent) {
      currentRequest.slaNotifiedBreachAt = now;
      currentRequest.slaLastBreachReminderAt = now;
      alertsSent += 1;
      await logSupportSlaEvent({
        request: currentRequest,
        source,
        label: 'SLA breach notification sent',
        changes: [
          { field: 'SLA Status', oldValue: previousSlaStatus || '—', newValue: currentSlaStatus || '—' },
          { field: 'Notified Assignee', oldValue: '—', newValue: assigneeEmail },
        ],
      });
    }
  }

  if (
    allowReminder
    && currentSlaStatus === 'breached'
    && policy.notifyOnBreach !== false
    && assigneeEmail
  ) {
    const reminderMinutes = clampMinutes(policy.breachReminderMinutes, 10, 1, 1440);
    const lastSentAt = toDateOrNull(currentRequest.slaLastBreachReminderAt || currentRequest.slaNotifiedBreachAt);
    const shouldSendReminder = (
      toDateOrNull(currentRequest.slaNotifiedBreachAt)
      && canSendReminder(lastSentAt, reminderMinutes, now)
    );
    if (shouldSendReminder) {
      const reminderResult = await sendSlaSlackDm(currentRequest, assigneeEmail, {
        event: 'reminder',
        reminderMinutes,
      });
      if (reminderResult?.sent) {
        currentRequest.slaLastBreachReminderAt = now;
        remindersSent += 1;
        await logSupportSlaEvent({
          request: currentRequest,
          source,
          label: `SLA breach reminder sent (${reminderMinutes}m cadence)`,
          changes: [{ field: 'Reminder Recipient', oldValue: '—', newValue: assigneeEmail }],
        });
      }
    }
  }

  if (
    currentSlaStatus === 'breached'
    && policy.autoEscalateOnBreach !== false
    && !toDateOrNull(currentRequest.slaEscalatedAt)
  ) {
    const escalationResult = await triggerSlaEscalation(currentRequest, people, { now, source });
    if (escalationResult.escalated) escalations += 1;
  }

  return { alertsSent, remindersSent, escalations };
}

function buildApprovalToken(request, step, managerEmail) {
  const expiresInSeconds = 60 * 60 * 48;
  const expiresAt = new Date(Date.now() + (expiresInSeconds * 1000));
  const token = jwt.sign(
    {
      kind: 'support_manager_approval',
      requestId: request._id.toString(),
      requestItemKey: step.key,
      managerEmail: String(managerEmail || '').toLowerCase(),
    },
    JWT_SECRET,
    { expiresIn: expiresInSeconds }
  );

  return {
    token,
    expiresAt,
    tokenHash: hashToken(token),
  };
}

async function notifySupportRequestChanges(previousRequest, currentRequest) {
  try {
    const previousChecklistItems = Array.isArray(previousRequest?.checklist) ? previousRequest.checklist : [];
    const currentChecklistItems = Array.isArray(currentRequest?.checklist) ? currentRequest.checklist : [];
    const previousChecklist = taskMap(previousChecklistItems);
    const softwareIds = [...new Set((currentRequest?.checklist || []).map(item => item.softwareCsvId).filter(Boolean))];
    const [userDirectory, softwareList] = await Promise.all([
      loadUserDirectory(),
      softwareIds.length
        ? Software.find({ csvId: { $in: softwareIds } }).select('csvId owner admins').lean()
        : Promise.resolve([]),
    ]);
    const softwareById = new Map((softwareList || []).map(item => [item.csvId, item]));

    const previousAssigneeInput = {
      userId: previousRequest?.assigneeUserId,
      email: previousRequest?.assigneeEmail,
      name: previousRequest?.assignee,
    };
    const currentAssigneeInput = {
      userId: currentRequest?.assigneeUserId,
      email: currentRequest?.assigneeEmail,
      name: currentRequest?.assignee,
    };
    const previousAssignee = resolvePersonWithDirectory(previousAssigneeInput, userDirectory);
    const currentAssignee = resolvePersonWithDirectory(currentAssigneeInput, userDirectory);

    if (!currentRequest.assigneeUserId && currentAssignee.userId) currentRequest.assigneeUserId = currentAssignee.userId;
    if (!currentRequest.assignee && currentAssignee.name) currentRequest.assignee = currentAssignee.name;
    if (!currentRequest.assigneeEmail && currentAssignee.email) currentRequest.assigneeEmail = currentAssignee.email;

    if (!previousRequest || personChanged(previousAssignee, currentAssignee)) {
      if (!currentAssignee.email) {
        console.warn(
          '[support notifications] assignee slack alert skipped: missing assignee email',
          {
            requestId: currentRequest?.requestId || '',
            assigneeUserId: currentAssignee.userId || '',
            assigneeName: currentAssignee.name || '',
          }
        );
      }
    }

    if (currentAssignee.email && (!previousRequest || personChanged(previousAssignee, currentAssignee))) {
      await sendAssignmentEmail({
        to: currentAssignee.email,
        templateKey: 'request_assignee',
        request: currentRequest,
      });
      const slackResult = await sendAssigneeSlackInboxMessage(currentRequest, currentAssignee.email);
      if (!slackResult?.sent) {
        console.warn(
          '[support notifications] assignee slack alert failed',
          {
            requestId: currentRequest?.requestId || '',
            assigneeEmail: currentAssignee.email || '',
            reason: slackResult?.reason || 'unknown',
          }
        );
      }
    }

    for (const step of currentRequest.checklist || []) {
      const previousStep = previousChecklist.get(step.key);
      const previousOwnerInput = {
        userId: previousStep?.ownerUserId,
        email: previousStep?.ownerEmail,
        name: previousStep?.owner,
      };
      const currentOwnerInput = {
        userId: step.ownerUserId,
        email: step.ownerEmail,
        name: step.owner,
      };
      const previousOwner = resolvePersonWithDirectory(previousOwnerInput, userDirectory);
      const currentOwner = resolvePersonWithDirectory(currentOwnerInput, userDirectory);

      if (!step.ownerUserId && currentOwner.userId) step.ownerUserId = currentOwner.userId;
      if (!step.owner && currentOwner.name) step.owner = currentOwner.name;
      if (!step.ownerEmail && currentOwner.email) step.ownerEmail = currentOwner.email;

      const stepRecipients = step.softwareCsvId
        ? uniqueEmails([
          ...softwareOwnerCandidates(softwareById.get(step.softwareCsvId), userDirectory),
          currentOwner,
        ])
        : uniqueEmails([currentOwner]);

      const ownerChanged = !previousStep || personChanged(previousOwner, currentOwner);
      const currentDependencySatisfied = dependencySatisfied(step, currentChecklistItems);
      const previousDependencySatisfied = previousStep
        ? dependencySatisfied(previousStep, previousChecklistItems)
        : false;
      const dependencyJustUnlocked = currentDependencySatisfied && (!previousStep || !previousDependencySatisfied);
      const stepPending = String(step?.status || 'pending') !== 'done';
      const shouldNotifyTaskAssignee = (
        stepRecipients.length
        && stepPending
        && currentDependencySatisfied
        && (ownerChanged || dependencyJustUnlocked)
      );

      if (shouldNotifyTaskAssignee) {
        const dependencyKey = String(step?.dependsOn || '').trim();
        const dependencyStep = dependencyKey
          ? (currentRequest.checklist || []).find(item => String(item?.key || '').trim() === dependencyKey)
          : null;
        const handoffMessage = String(dependencyStep?.handoffMessage || '').trim();
        await sendAssignmentEmail({
          to: stepRecipients,
          templateKey: 'task_assignment',
          request: currentRequest,
          stepLabel: step.label,
          handoffMessage,
        });
        await sendTaskAssigneeSlackInboxMessages(currentRequest, step, stepRecipients, { handoffMessage });
      }

      if (step.approvalMode !== 'manager' || !currentRequest.managerEmail || step.status === 'done') continue;
      if (!currentDependencySatisfied) continue;

      const needsApprovalEmail = (
        !previousStep
        || previousStep.approvalMode !== 'manager'
        || !step.approvalRequestedAt
        || String(previousRequest?.managerEmail || '').toLowerCase() !== String(currentRequest.managerEmail || '').toLowerCase()
        || previousStep.status === 'done'
      );

      if (!needsApprovalEmail) continue;

      const { token, tokenHash, expiresAt } = buildApprovalToken(currentRequest, step, currentRequest.managerEmail);
      const [emailSent, slackSent] = await Promise.all([
        sendManagerApprovalEmail(currentRequest, step, token),
        sendManagerApprovalSlackInboxMessage(currentRequest, step, token),
      ]);
      if (!emailSent && !slackSent) continue;

      step.approvalTokenHash = tokenHash;
      step.approvalTokenExpiresAt = expiresAt;
      step.approvalRequestedAt = new Date();
      step.approvalRespondedAt = null;
      step.approvalActorName = '';
      step.approvalActorEmail = '';
      step.approvalDecision = '';
      step.approvalStatus = 'pending';
    }

    await processSlaNotifications(previousRequest, currentRequest, {
      userDirectory,
      source: 'support_center',
      allowReminder: false,
      now: new Date(),
    });
  } catch (error) {
    console.error('[support notifications]', error.message);
  }
}

async function runSupportSlaMonitor(options = {}) {
  const batchSize = clampMinutes(options.batchSize, 500, 1, 5000);
  const now = new Date();
  try {
    const requests = await SupportRequest.find({
      status: { $nin: ['completed', 'cancelled'] },
      'slaPolicySnapshot.enabled': { $ne: false },
    })
      .sort({ updatedAt: -1 })
      .limit(batchSize);

    if (!requests.length) {
      return { processed: 0, updated: 0, alertsSent: 0, remindersSent: 0, escalations: 0 };
    }

    const userDirectory = await loadUserDirectory();
    let updated = 0;
    let alertsSent = 0;
    let remindersSent = 0;
    let escalations = 0;

    for (const request of requests) {
      const previous = request.toObject();
      const snapshot = evaluateRequestSla(request, now);
      applySlaSnapshotToRequest(request, snapshot);

      const results = await processSlaNotifications(previous, request, {
        userDirectory,
        source: 'sla_monitor',
        allowReminder: true,
        now,
      });
      alertsSent += Number(results.alertsSent || 0);
      remindersSent += Number(results.remindersSent || 0);
      escalations += Number(results.escalations || 0);

      if (request.isModified()) {
        await request.save();
        updated += 1;
      }
    }

    return {
      processed: requests.length,
      updated,
      alertsSent,
      remindersSent,
      escalations,
    };
  } catch (error) {
    console.error('[support sla monitor]', error.message);
    return { processed: 0, updated: 0, alertsSent: 0, remindersSent: 0, escalations: 0, error: error.message };
  }
}

module.exports = {
  hashToken,
  notifySupportRequestChanges,
  runSupportSlaMonitor,
};
