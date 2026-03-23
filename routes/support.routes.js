const router = require('express').Router();
const jwt = require('jsonwebtoken');

// Escape special regex characters to prevent ReDoS from user-supplied search strings.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const { SupportRequest } = require('../db');
const { requireAuth, canWrite, requirePermission, onlySuperAdmin } = require('../middleware/auth');
const { JWT_SECRET } = require('../config');
const {
  applySupportRequestUpdates,
  createRequestTypeDefinition,
  createSupportRequest,
  ensureCompletedOnboardingProvisioningReady,
  formatWorkflowTypeLabel,
  listRequestTypeDefinitions,
  listWorkflowOptions,
  syncCompletedOnboardingUser,
  updateRequestTypeDefinition,
} = require('../services/support-request.service');
const {
  listSupportMailTemplates,
  updateSupportMailTemplate,
} = require('../services/support-mail-template.service');
const { hashToken, notifySupportRequestChanges } = require('../services/support-notification.service');
const rateLimit = require('express-rate-limit');

// Prevent brute-force guessing of approval tokens: max 10 attempts per 15 min per IP.
const approvalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many approval attempts from this IP, please try again later.' },
});

function fmtSupportRequest(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  const checklist = Array.isArray(o.checklist) ? o.checklist : [];
  const completedCount = checklist.filter(item => item.status === 'done').length;

  return {
    id: o._id.toString(),
    requestId: o.requestId,
    workflowType: o.workflowType,
    workflowLabel: o.workflowLabel || formatWorkflowTypeLabel(o.workflowType),
    sourceSystem: o.sourceSystem || 'portal',
    sourceWorkflowSourceId: o.sourceWorkflowSourceId || '',
    sourceWorkflowKey: o.sourceWorkflowKey || '',
    requestedVia: o.requestedVia || 'portal',
    status: o.status,
    priority: o.priority,
    employeeName: o.employeeName,
    employeeEmail: o.employeeEmail,
    department: o.department,
    jobTitle: o.jobTitle,
    location: o.location,
    managerName: o.managerName,
    managerUserId: o.managerUserId || '',
    managerEmail: o.managerEmail || '',
    startDate: o.startDate,
    endDate: o.endDate,
    requestedById: o.requestedById,
    requestedByName: o.requestedByName,
    requestedByEmail: o.requestedByEmail,
    assignee: o.assignee,
    assigneeUserId: o.assigneeUserId || '',
    assigneeEmail: o.assigneeEmail || '',
    applications: Array.isArray(o.applications) ? o.applications : [],
    notes: o.notes,
    checklist,
    progressPercent: checklist.length ? Math.round((completedCount / checklist.length) * 100) : 0,
    completedCount,
    totalTasks: checklist.length,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function approvalPage(title, body, tone = '#111827') {
  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width,initial-scale=1" />
      <title>${title}</title>
    </head>
    <body style="margin:0;background:#0f172a;color:#e2e8f0;font-family:Arial,sans-serif">
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
        <div style="max-width:560px;width:100%;background:#1e293b;border:1px solid rgba(148,163,184,0.2);border-radius:20px;padding:28px">
          <div style="font-size:28px;font-weight:800;color:${tone};margin-bottom:14px">${title}</div>
          <div style="font-size:15px;line-height:1.7;color:#cbd5e1">${body}</div>
        </div>
      </div>
    </body>
  </html>`;
}

router.get('/approval-action', approvalRateLimiter, async (req, res) => {
  try {
    const token = String(req.query.token || '').trim();
    const decision = String(req.query.decision || '').trim().toLowerCase();
    if (!token || !['approve', 'reject'].includes(decision)) {
      return res.status(400).send(approvalPage('Invalid approval link', 'This approval link is incomplete or malformed.', '#f87171'));
    }

    const payload = jwt.verify(token, JWT_SECRET);
    if (payload.kind !== 'support_manager_approval') {
      return res.status(400).send(approvalPage('Invalid approval link', 'This approval token is not valid for support request approvals.', '#f87171'));
    }

    const request = await SupportRequest.findById(payload.requestId);
    if (!request) {
      return res.status(404).send(approvalPage('Request not found', 'The support request for this approval link could not be found.', '#f87171'));
    }

    const step = (request.checklist || []).find(item => item.key === payload.requestItemKey);
    if (!step || step.approvalMode !== 'manager') {
      return res.status(404).send(approvalPage('Step not found', 'The manager approval step for this link is no longer available.', '#f87171'));
    }

    if (step.approvalTokenHash !== hashToken(token)) {
      return res.status(400).send(approvalPage('Approval link expired', 'This approval link has already been replaced or is no longer valid.', '#f87171'));
    }

    if (step.approvalTokenExpiresAt && step.approvalTokenExpiresAt.getTime() < Date.now()) {
      return res.status(400).send(approvalPage('Approval link expired', 'This approval link has expired. Ask the support team to resend it.', '#f87171'));
    }

    if (String(request.managerEmail || '').toLowerCase() !== String(payload.managerEmail || '').toLowerCase()) {
      return res.status(400).send(approvalPage('Approval link mismatch', 'This approval link no longer matches the current manager for the request.', '#f87171'));
    }

    if (decision === 'approve') {
      step.status = 'done';
      step.approvalStatus = 'approved';
      step.approvalDecision = 'approve';
      request.status = request.status === 'blocked' ? 'in_progress' : request.status;
    } else {
      step.status = 'pending';
      step.approvalStatus = 'rejected';
      step.approvalDecision = 'reject';
      request.status = 'blocked';
    }

    step.approvalRespondedAt = new Date();
    step.approvalActorName = request.managerName || 'Manager';
    step.approvalActorEmail = request.managerEmail || '';
    step.approvalTokenHash = '';
    step.approvalTokenExpiresAt = null;
    step.notes = `${step.notes ? `${step.notes}\n` : ''}Manager ${decision === 'approve' ? 'approved' : 'rejected'} on ${new Date().toLocaleString('en-IN')}`.trim();

    await request.save();

    return res.send(
      approvalPage(
        decision === 'approve' ? 'Approval recorded' : 'Request rejected',
        decision === 'approve'
          ? `You approved <strong>${step.label}</strong> for request <strong>${request.requestId}</strong>. The support team can continue the workflow now.`
          : `You rejected <strong>${step.label}</strong> for request <strong>${request.requestId}</strong>. The request has been marked blocked for follow-up.`,
        decision === 'approve' ? '#4ade80' : '#f87171'
      )
    );
  } catch {
    return res.status(400).send(approvalPage('Approval link expired', 'This manager approval link is invalid or has expired. Ask the support team to resend it.', '#f87171'));
  }
});

router.get('/workflows', requireAuth, async (req, res) => {
  try {
    const workflows = await listWorkflowOptions();
    res.json(workflows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/request-types', requireAuth, async (req, res) => {
  try {
    const requestTypes = await listRequestTypeDefinitions();
    res.json(requestTypes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/request-types', requireAuth, requirePermission('manageRequestTypes'), async (req, res) => {
  try {
    const requestType = await createRequestTypeDefinition(req.body || {});
    res.status(201).json(requestType);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/request-types/:id', requireAuth, requirePermission('manageRequestTypes'), async (req, res) => {
  try {
    const requestType = await updateRequestTypeDefinition(req.params.id, req.body || {});
    res.json(requestType);
  } catch (e) {
    res.status(e.message === 'Request type not found.' ? 404 : 400).json({ error: e.message });
  }
});

router.get('/mail-templates', requireAuth, onlySuperAdmin, async (req, res) => {
  try {
    const templates = await listSupportMailTemplates();
    res.json(templates.map(template => ({
      id: template._id?.toString?.() || template.id,
      key: template.key,
      label: template.label,
      audience: template.audience || '',
      description: template.description || '',
      tokens: Array.isArray(template.tokens) ? template.tokens : [],
      subjectTemplate: template.subjectTemplate || '',
      introTemplate: template.introTemplate || '',
      bodyTemplate: template.bodyTemplate || '',
      ctaLabel: template.ctaLabel || '',
      secondaryCtaLabel: template.secondaryCtaLabel || '',
      footerNote: template.footerNote || '',
      sortOrder: template.sortOrder || 0,
      isSystem: template.isSystem !== false,
      updatedAt: template.updatedAt || null,
    })));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/mail-templates/:id', requireAuth, onlySuperAdmin, async (req, res) => {
  try {
    const template = await updateSupportMailTemplate(req.params.id, req.body || {});
    res.json({
      id: template._id?.toString?.() || template.id,
      key: template.key,
      label: template.label,
      audience: template.audience || '',
      description: template.description || '',
      tokens: Array.isArray(template.tokens) ? template.tokens : [],
      subjectTemplate: template.subjectTemplate || '',
      introTemplate: template.introTemplate || '',
      bodyTemplate: template.bodyTemplate || '',
      ctaLabel: template.ctaLabel || '',
      secondaryCtaLabel: template.secondaryCtaLabel || '',
      footerNote: template.footerNote || '',
      sortOrder: template.sortOrder || 0,
      isSystem: template.isSystem !== false,
      updatedAt: template.updatedAt || null,
    });
  } catch (e) {
    res.status(e.message === 'Mail template not found.' ? 404 : 400).json({ error: e.message });
  }
});

router.get('/', requireAuth, async (req, res) => {
  try {
    const { workflowType, status, search } = req.query;
    const filter = {};
    if (workflowType) filter.workflowType = workflowType;
    if (status) filter.status = status;
    if (search) {
      const re = new RegExp(escapeRegex(String(search).slice(0, 200)), 'i');
      filter.$or = [
        { requestId: re },
        { employeeName: re },
        { employeeEmail: re },
        { department: re },
        { requestedByName: re },
        { assignee: re },
        { workflowLabel: re },
      ];
    }

    const requests = await SupportRequest.find(filter).sort({ createdAt: -1 });
    res.json(requests.map(fmtSupportRequest));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const supportRequest = await createSupportRequest(body, {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
    }, {
      requestedVia: 'portal',
    });
    ensureCompletedOnboardingProvisioningReady(supportRequest);
    await notifySupportRequestChanges(null, supportRequest);
    if (supportRequest.isModified()) await supportRequest.save();
    await syncCompletedOnboardingUser(supportRequest);

    res.status(201).json(fmtSupportRequest(supportRequest));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/:id', requireAuth, canWrite, async (req, res) => {
  try {
    const request = await SupportRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ error: 'Support request not found' });
    const previousRequest = request.toObject();

    const body = req.body || {};
    const allowedFields = ['status', 'priority', 'department', 'jobTitle', 'location', 'startDate', 'endDate', 'notes'];
    for (const field of allowedFields) {
      if (body[field] !== undefined) request[field] = body[field];
    }
    await applySupportRequestUpdates(request, body);
    ensureCompletedOnboardingProvisioningReady(request);

    await request.save();
    await notifySupportRequestChanges(previousRequest, request);
    if (request.isModified()) await request.save();
    await syncCompletedOnboardingUser(request);
    res.json(fmtSupportRequest(request));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, canWrite, async (req, res) => {
  try {
    const request = await SupportRequest.findByIdAndDelete(req.params.id);
    if (!request) return res.status(404).json({ error: 'Support request not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
