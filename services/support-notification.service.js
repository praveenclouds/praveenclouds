const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { loadEmailSettings, sendMail } = require('./email.service');

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

function requestSummary(request = {}) {
  return [
    `Request ID: ${request.requestId}`,
    `Request Type: ${request.workflowLabel || request.workflowType}`,
    `Employee: ${request.employeeName} <${request.employeeEmail}>`,
    request.department ? `Department: ${request.department}` : '',
    request.priority ? `Priority: ${request.priority}` : '',
  ].filter(Boolean).join('\n');
}

async function sendAssignmentEmail({ to, subject, intro, request, stepLabel = '' }) {
  if (!to) return;
  const settings = await loadEmailSettings();
  const detailUrl = requestDetailUrl(settings.appBaseUrl);
  const stepLine = stepLabel ? `Task: ${stepLabel}\n` : '';
  await sendMail({
    to,
    subject,
    text: `${intro}\n\n${stepLine}${requestSummary(request)}\n\nOpen Support Center: ${detailUrl}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        <p>${intro}</p>
        ${stepLabel ? `<p><strong>Task:</strong> ${stepLabel}</p>` : ''}
        <p><strong>Request ID:</strong> ${request.requestId}<br>
        <strong>Request Type:</strong> ${request.workflowLabel || request.workflowType}<br>
        <strong>Employee:</strong> ${request.employeeName} (${request.employeeEmail})<br>
        ${request.department ? `<strong>Department:</strong> ${request.department}<br>` : ''}
        ${request.priority ? `<strong>Priority:</strong> ${request.priority}</p>` : '</p>'}
        <p><a href="${detailUrl}" style="display:inline-block;padding:10px 16px;background:#3757e6;color:#fff;text-decoration:none;border-radius:8px">Open Support Center</a></p>
      </div>
    `,
  });
}

async function sendManagerApprovalEmail(request, step, token) {
  if (!request?.managerEmail) return false;
  const settings = await loadEmailSettings();
  const approveUrl = approvalActionUrl(settings.appBaseUrl, token, 'approve');
  const rejectUrl = approvalActionUrl(settings.appBaseUrl, token, 'reject');

  const result = await sendMail({
    to: request.managerEmail,
    subject: `Approval needed: ${step.label} for ${request.employeeName}`,
    text: [
      `Approval is needed for support request ${request.requestId}.`,
      '',
      `Task: ${step.label}`,
      requestSummary(request),
      '',
      `Approve: ${approveUrl}`,
      `Reject: ${rejectUrl}`,
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#111827">
        <p>Approval is needed for support request <strong>${request.requestId}</strong>.</p>
        <p><strong>Task:</strong> ${step.label}<br>
        <strong>Request Type:</strong> ${request.workflowLabel || request.workflowType}<br>
        <strong>Employee:</strong> ${request.employeeName} (${request.employeeEmail})<br>
        ${request.department ? `<strong>Department:</strong> ${request.department}<br>` : ''}
        ${request.priority ? `<strong>Priority:</strong> ${request.priority}</p>` : '</p>'}
        <p style="display:flex;gap:12px;flex-wrap:wrap">
          <a href="${approveUrl}" style="display:inline-block;padding:10px 16px;background:#16a34a;color:#fff;text-decoration:none;border-radius:8px">Approve</a>
          <a href="${rejectUrl}" style="display:inline-block;padding:10px 16px;background:#dc2626;color:#fff;text-decoration:none;border-radius:8px">Reject</a>
        </p>
        <p style="font-size:12px;color:#6b7280">These links expire in 48 hours.</p>
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
        subject: `Support request assigned: ${currentRequest.requestId}`,
        intro: `A support request has been assigned to you.`,
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

      if (currentOwner.email && (!previousStep || personChanged(previousOwner, currentOwner))) {
        await sendAssignmentEmail({
          to: currentOwner.email,
          subject: `Task assigned: ${step.label}`,
          intro: `A workflow task has been assigned to you.`,
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
