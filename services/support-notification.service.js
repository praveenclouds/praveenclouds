const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { Software } = require('../db');
const { JWT_SECRET } = require('../config');
const { loadEmailSettings, sendMail } = require('./email.service');
const { renderSupportMailTemplate } = require('./support-mail-template.service');
const { loadUserDirectory, softwareOwnerCandidates } = require('./support-request.service');

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

function fallbackValue(value, fallback = '—') {
  const normalized = String(value || '').trim();
  return normalized || fallback;
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
    detailUrl: extra.detailUrl || '',
    approveUrl: extra.approveUrl || '',
    rejectUrl: extra.rejectUrl || '',
  };
}

async function sendAssignmentEmail({ to, templateKey, request, stepLabel = '' }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!recipients.length) return;
  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const rendered = await renderSupportMailTemplate(templateKey, templateContext(request, { stepLabel, detailUrl }));
  const actionLabel = rendered.ctaLabel || 'Open Support Center';
  await sendMail({
    to: recipients,
    subject: rendered.subject,
    text: [
      rendered.intro,
      rendered.body,
      detailUrl ? `${actionLabel}: ${detailUrl}` : '',
      rendered.footerNote,
    ].filter(Boolean).join('\n\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        ${rendered.intro ? `<p>${escapeHtml(rendered.intro)}</p>` : ''}
        ${bodyToHtml(rendered.body)}
        ${detailUrl ? `<p><a href="${escapeHtml(detailUrl)}" style="display:inline-block;padding:10px 16px;background:#3757e6;color:#fff;text-decoration:none;border-radius:8px">${escapeHtml(actionLabel)}</a></p>` : ''}
        ${rendered.footerNote ? `<p style="font-size:12px;color:#6b7280">${escapeHtml(rendered.footerNote)}</p>` : ''}
      </div>
    `,
  });
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
    const previousChecklist = taskMap(previousRequest?.checklist || []);
    const softwareIds = [...new Set((currentRequest?.checklist || []).map(item => item.softwareCsvId).filter(Boolean))];
    const [userDirectory, softwareList] = await Promise.all([
      softwareIds.length ? loadUserDirectory() : Promise.resolve(null),
      softwareIds.length
        ? Software.find({ csvId: { $in: softwareIds } }).select('csvId owner admins').lean()
        : Promise.resolve([]),
    ]);
    const softwareById = new Map((softwareList || []).map(item => [item.csvId, item]));

    const previousAssignee = {
      userId: previousRequest?.assigneeUserId,
      email: previousRequest?.assigneeEmail,
      name: previousRequest?.assignee,
    };
    const currentAssignee = {
      userId: currentRequest?.assigneeUserId,
      email: currentRequest?.assigneeEmail,
      name: currentRequest?.assignee,
    };

    if (currentAssignee.email && (!previousRequest || personChanged(previousAssignee, currentAssignee))) {
      await sendAssignmentEmail({
        to: currentAssignee.email,
        templateKey: 'request_assignee',
        request: currentRequest,
      });
    }

    for (const step of currentRequest.checklist || []) {
      const previousStep = previousChecklist.get(step.key);
      const previousOwner = {
        userId: previousStep?.ownerUserId,
        email: previousStep?.ownerEmail,
        name: previousStep?.owner,
      };
      const currentOwner = {
        userId: step.ownerUserId,
        email: step.ownerEmail,
        name: step.owner,
      };
      const stepRecipients = step.softwareCsvId
        ? uniqueEmails([
          ...softwareOwnerCandidates(softwareById.get(step.softwareCsvId), userDirectory),
          currentOwner,
        ])
        : uniqueEmails([currentOwner]);

      if (stepRecipients.length && (!previousStep || personChanged(previousOwner, currentOwner))) {
        await sendAssignmentEmail({
          to: stepRecipients,
          templateKey: 'task_assignment',
          request: currentRequest,
          stepLabel: step.label,
        });
      }

      if (step.approvalMode !== 'manager' || !currentRequest.managerEmail || step.status === 'done') continue;

      const needsApprovalEmail = (
        !previousStep
        || previousStep.approvalMode !== 'manager'
        || !step.approvalRequestedAt
        || String(previousRequest?.managerEmail || '').toLowerCase() !== String(currentRequest.managerEmail || '').toLowerCase()
        || previousStep.status === 'done'
      );

      if (!needsApprovalEmail) continue;

      const { token, tokenHash, expiresAt } = buildApprovalToken(currentRequest, step, currentRequest.managerEmail);
      const sent = await sendManagerApprovalEmail(currentRequest, step, token);
      if (!sent) continue;

      step.approvalTokenHash = tokenHash;
      step.approvalTokenExpiresAt = expiresAt;
      step.approvalRequestedAt = new Date();
      step.approvalRespondedAt = null;
      step.approvalActorName = '';
      step.approvalActorEmail = '';
      step.approvalDecision = '';
      step.approvalStatus = 'pending';
    }
  } catch (error) {
    console.error('[support notifications]', error.message);
  }
}

module.exports = {
  hashToken,
  notifySupportRequestChanges,
};
