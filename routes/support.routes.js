const router = require('express').Router();
const jwt = require('jsonwebtoken');

// Escape special regex characters to prevent ReDoS from user-supplied search strings.
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
const { SupportRequest, SupportRequestType, Log } = require('../db');
const { requireAuth, canWrite, requirePermission, onlySuperAdmin } = require('../middleware/auth');
const { JWT_SECRET } = require('../config');
const {
  applySupportRequestUpdates,
  createRequestTypeDefinition,
  createSupportRequest,
  deleteRequestTypeDefinition,
  ensureCompletedOnboardingProvisioningReady,
  formatWorkflowTypeLabel,
  listRequestTypeDefinitions,
  listWorkflowOptions,
  syncCompletedOnboardingUser,
  syncCompletedOffboardingUser,
  updateRequestTypeDefinition,
} = require('../services/support-request.service');
const {
  listSupportMailTemplates,
  updateSupportMailTemplate,
} = require('../services/support-mail-template.service');
const {
  logSupportRequestApprovalAction,
  logSupportRequestCreated,
  logSupportRequestDeleted,
  logSupportRequestUpdated,
} = require('../services/support-log.service');
const { hashToken, notifySupportRequestChanges } = require('../services/support-notification.service');
const { postSupportRequestUpdateMessage } = require('../services/support-slack-thread.service');
const rateLimit = require('express-rate-limit');

const DEFAULT_SLA_POLICY = SupportRequestType.DEFAULT_SLA_POLICY || Object.freeze({
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
});
const normalizePriority = SupportRequestType.normalizePriority
  || (value => {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'critical') return 'high';
    return ['low', 'medium', 'high'].includes(normalized) ? normalized : 'medium';
  });
const getSlaMinutesForPriority = SupportRequestType.getSlaMinutesForPriority
  || ((policy = {}, priority = 'medium', kind = 'resolution') => {
    const normalized = normalizePriority(priority);
    if (kind === 'response') {
      return Number(policy?.priorityResponseMinutes?.[normalized] || policy?.responseMinutes || 60);
    }
    return Number(policy?.priorityResolutionMinutes?.[normalized] || policy?.resolutionMinutes || 480);
  });

// Prevent brute-force guessing of approval tokens: max 10 attempts per 15 min per IP.
const approvalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many approval attempts from this IP, please try again later.' },
});

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeSlaPolicySnapshot(input = {}) {
  const policy = { ...DEFAULT_SLA_POLICY, ...(input || {}) };
  const toInt = (value, fallback, min, max) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };
  return {
    enabled: policy.enabled !== false,
    responseMinutes: toInt(policy.responseMinutes, DEFAULT_SLA_POLICY.responseMinutes, 1, 43200),
    resolutionMinutes: toInt(policy.resolutionMinutes, DEFAULT_SLA_POLICY.resolutionMinutes, 1, 43200),
    atRiskPercent: toInt(policy.atRiskPercent, DEFAULT_SLA_POLICY.atRiskPercent, 1, 99),
    priorityResponseMinutes: {
      low: toInt(policy?.priorityResponseMinutes?.low, DEFAULT_SLA_POLICY?.priorityResponseMinutes?.low || 120, 1, 43200),
      medium: toInt(policy?.priorityResponseMinutes?.medium, DEFAULT_SLA_POLICY?.priorityResponseMinutes?.medium || 60, 1, 43200),
      high: toInt(policy?.priorityResponseMinutes?.high, DEFAULT_SLA_POLICY?.priorityResponseMinutes?.high || 30, 1, 43200),
    },
    priorityResolutionMinutes: {
      low: toInt(policy?.priorityResolutionMinutes?.low, DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.low || 120, 1, 43200),
      medium: toInt(policy?.priorityResolutionMinutes?.medium, DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.medium || 60, 1, 43200),
      high: toInt(policy?.priorityResolutionMinutes?.high, DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.high || 30, 1, 43200),
    },
    breachReminderMinutes: toInt(policy.breachReminderMinutes, DEFAULT_SLA_POLICY?.breachReminderMinutes || 10, 1, 1440),
    notifyAtRisk: policy.notifyAtRisk !== false,
    notifyOnBreach: policy.notifyOnBreach !== false,
    autoEscalateOnBreach: policy.autoEscalateOnBreach !== false,
  };
}

function deriveSlaPayload(request = {}) {
  const now = new Date();
  const policy = normalizeSlaPolicySnapshot(request.slaPolicySnapshot || {});
  const createdAt = toDateOrNull(request.createdAt) || now;
  const priority = normalizePriority(request.priority);
  const firstResponseAt = toDateOrNull(request.firstResponseAt);
  const resolvedAt = toDateOrNull(request.resolvedAt);

  if (!policy.enabled) {
    return {
      slaPolicySnapshot: policy,
      firstResponseAt,
      resolvedAt,
      slaResponseDueAt: null,
      slaResolutionDueAt: null,
      slaStatus: 'no_sla',
      slaBreachedAt: null,
    };
  }

  const responseMinutes = getSlaMinutesForPriority(policy, priority, 'response');
  const resolutionMinutes = getSlaMinutesForPriority(policy, priority, 'resolution');
  const slaResponseDueAt = toDateOrNull(request.slaResponseDueAt)
    || new Date(createdAt.getTime() + (responseMinutes * 60 * 1000));
  const slaResolutionDueAt = toDateOrNull(request.slaResolutionDueAt)
    || new Date(createdAt.getTime() + (resolutionMinutes * 60 * 1000));

  let slaStatus = String(request.slaStatus || '').trim();
  const validStatuses = new Set(['on_track', 'at_risk', 'breached', 'met', 'paused', 'no_sla']);
  if (!validStatuses.has(slaStatus)) {
    const status = String(request.status || '').toLowerCase();
    if (status === 'cancelled') {
      slaStatus = 'paused';
    } else if (status === 'completed') {
      const completedAt = resolvedAt || now;
      slaStatus = completedAt.getTime() > slaResolutionDueAt.getTime() ? 'breached' : 'met';
    } else if ((!firstResponseAt && now.getTime() > slaResponseDueAt.getTime()) || now.getTime() > slaResolutionDueAt.getTime()) {
      slaStatus = 'breached';
    } else {
      const totalMs = slaResolutionDueAt.getTime() - createdAt.getTime();
      const elapsedMs = now.getTime() - createdAt.getTime();
      const elapsedPercent = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
      slaStatus = elapsedPercent >= policy.atRiskPercent ? 'at_risk' : 'on_track';
    }
  }

  return {
    slaPolicySnapshot: policy,
    firstResponseAt,
    resolvedAt,
    slaResponseDueAt,
    slaResolutionDueAt,
    slaStatus,
    slaBreachedAt: toDateOrNull(request.slaBreachedAt),
  };
}

function fmtSupportRequest(doc) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  const checklist = Array.isArray(o.checklist) ? o.checklist : [];
  const completedCount = checklist.filter(item => item.status === 'done').length;
  const sla = deriveSlaPayload(o);

  return {
    id: o._id.toString(),
    requestId: o.requestId,
    workflowType: o.workflowType,
    workflowLabel: o.workflowLabel || formatWorkflowTypeLabel(o.workflowType),
    sourceSystem: o.sourceSystem || 'portal',
    sourceWorkflowSourceId: o.sourceWorkflowSourceId || '',
    sourceWorkflowKey: o.sourceWorkflowKey || '',
    requestedVia: o.requestedVia || 'portal',
    slackChannelId: o.slackChannelId || '',
    slackMessageTs: o.slackMessageTs || '',
    slackThreadTs: o.slackThreadTs || '',
    slackTeamId: o.slackTeamId || '',
    slackCommandUserId: o.slackCommandUserId || '',
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
    slaPolicySnapshot: sla.slaPolicySnapshot,
    firstResponseAt: sla.firstResponseAt,
    resolvedAt: sla.resolvedAt,
    slaResponseDueAt: sla.slaResponseDueAt,
    slaResolutionDueAt: sla.slaResolutionDueAt,
    slaStatus: sla.slaStatus,
    slaBreachedAt: sla.slaBreachedAt,
    slaNotifiedAtRiskAt: o.slaNotifiedAtRiskAt || null,
    slaNotifiedBreachAt: o.slaNotifiedBreachAt || null,
    slaLastBreachReminderAt: o.slaLastBreachReminderAt || null,
    slaEscalatedAt: o.slaEscalatedAt || null,
    applications: Array.isArray(o.applications) ? o.applications : [],
    notes: o.notes,
    customFieldValues: Array.isArray(o.customFieldValues) ? o.customFieldValues : [],
    checklist,
    progressPercent: checklist.length ? Math.round((completedCount / checklist.length) * 100) : 0,
    completedCount,
    totalTasks: checklist.length,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function fmtSupportLog(doc) {
  const log = doc?.toObject ? doc.toObject() : { ...(doc || {}) };
  return {
    id: log._id?.toString?.() || '',
    eventType: log.eventType || '',
    entityType: log.entityType || '',
    entityId: log.entityId || '',
    entityLabel: log.entityLabel || '',
    summary: log.summary || '',
    remarks: log.remarks || '',
    actorName: log.actorName || '',
    changes: Array.isArray(log.changes) ? log.changes : [],
    createdAt: log.createdAt || null,
  };
}

function buildSupportRequestFilter(query = {}) {
  const {
    workflowType,
    status,
    priority,
    slaStatus,
    assignee,
    search,
  } = query || {};
  const filter = {};
  if (workflowType) filter.workflowType = String(workflowType).trim();
  if (status) filter.status = String(status).trim();
  if (priority) filter.priority = normalizePriority(priority);
  if (slaStatus) filter.slaStatus = String(slaStatus).trim();
  if (assignee) filter.assignee = String(assignee).trim();
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
  return filter;
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

async function persistSlackThreadContext(request, slackPost = {}) {
  if (!request || !slackPost?.posted) return;
  if (!request.slackChannelId && slackPost.channelId) request.slackChannelId = slackPost.channelId;
  if (!request.slackMessageTs && slackPost.messageTs) request.slackMessageTs = slackPost.messageTs;
  if (!request.slackThreadTs && slackPost.threadTs) request.slackThreadTs = slackPost.threadTs;
  if (request.isModified()) await request.save();
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
    const previousRequest = request.toObject();

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
      if (!['completed', 'cancelled'].includes(String(request.status || '').toLowerCase())) {
        request.status = 'in_progress';
      }
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
    const slackPost = await postSupportRequestUpdateMessage(previousRequest, request, {
      source: 'manager_approval',
      actor: request.managerName || 'Manager',
    });
    await persistSlackThreadContext(request, slackPost);
    await logSupportRequestUpdated(previousRequest, request, request.managerName || request.managerEmail || 'Manager', 'manager_approval');
    await logSupportRequestApprovalAction({
      request,
      step,
      decision,
      actorName: request.managerName || request.managerEmail || 'Manager',
      source: 'manager_approval',
    });

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

router.delete('/request-types/:id', requireAuth, requirePermission('manageRequestTypes'), async (req, res) => {
  try {
    const deleted = await deleteRequestTypeDefinition(req.params.id);
    res.json({ ok: true, ...deleted });
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
    const filter = buildSupportRequestFilter(req.query);

    const requests = await SupportRequest.find(filter).sort({ createdAt: -1 });
    res.json(requests.map(fmtSupportRequest));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/board', requireAuth, async (req, res) => {
  try {
    const filter = buildSupportRequestFilter(req.query);
    const requests = await SupportRequest.find(filter).sort({ updatedAt: -1, createdAt: -1 });
    const formatted = requests.map(fmtSupportRequest);

    const statuses = ['open', 'in_progress', 'blocked', 'completed', 'cancelled'];
    const columns = Object.fromEntries(statuses.map(status => [status, []]));
    formatted.forEach(request => {
      const status = statuses.includes(request.status) ? request.status : 'open';
      columns[status].push(request);
    });

    const counts = Object.fromEntries(statuses.map(status => [status, columns[status].length]));
    const slaStatuses = ['on_track', 'at_risk', 'breached', 'met', 'paused', 'no_sla'];
    const slaCounts = Object.fromEntries(slaStatuses.map(key => [key, 0]));
    formatted.forEach(request => {
      const key = slaStatuses.includes(request.slaStatus) ? request.slaStatus : 'no_sla';
      slaCounts[key] += 1;
    });
    res.json({
      total: formatted.length,
      counts,
      slaCounts,
      columns,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/sla-dashboard', requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const since = new Date(Date.now() - (days * 24 * 60 * 60 * 1000));
    const filter = buildSupportRequestFilter(req.query);
    filter.createdAt = { $gte: since };

    const rows = (await SupportRequest.find(filter).sort({ createdAt: -1 })).map(fmtSupportRequest);
    const tracked = rows.filter(item => item?.slaPolicySnapshot?.enabled !== false);
    const completed = tracked.filter(item => String(item.status || '').toLowerCase() === 'completed');
    const active = tracked.filter(item => !['completed', 'cancelled'].includes(String(item.status || '').toLowerCase()));
    const metCount = completed.filter(item => item.slaStatus === 'met').length;
    const completedBreachedCount = completed.filter(item => item.slaStatus === 'breached').length;
    const activeAtRiskCount = active.filter(item => item.slaStatus === 'at_risk').length;
    const activeBreachedCount = active.filter(item => item.slaStatus === 'breached').length;
    const complianceRate = completed.length ? Math.round((metCount / completed.length) * 1000) / 10 : 100;

    const resolutionSamples = completed
      .map(item => {
        const createdAt = toDateOrNull(item.createdAt);
        const resolvedAt = toDateOrNull(item.resolvedAt || item.updatedAt);
        if (!createdAt || !resolvedAt) return null;
        return Math.max(0, Math.round((resolvedAt.getTime() - createdAt.getTime()) / 60000));
      })
      .filter(value => Number.isFinite(value));
    const averageResolutionMinutes = resolutionSamples.length
      ? Math.round(resolutionSamples.reduce((sum, value) => sum + value, 0) / resolutionSamples.length)
      : 0;

    const byPriority = ['high', 'medium', 'low'].map(priority => {
      const priorityRows = tracked.filter(item => normalizePriority(item.priority) === priority);
      const priorityCompleted = priorityRows.filter(item => String(item.status || '').toLowerCase() === 'completed');
      const priorityMet = priorityCompleted.filter(item => item.slaStatus === 'met').length;
      const priorityBreached = priorityCompleted.filter(item => item.slaStatus === 'breached').length;
      return {
        priority,
        total: priorityRows.length,
        completed: priorityCompleted.length,
        met: priorityMet,
        breached: priorityBreached,
        complianceRate: priorityCompleted.length
          ? Math.round((priorityMet / priorityCompleted.length) * 1000) / 10
          : 100,
      };
    });

    const lastSevenDays = Array.from({ length: 7 }).map((_, idx) => {
      const day = new Date();
      day.setHours(0, 0, 0, 0);
      day.setDate(day.getDate() - (6 - idx));
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);

      const dayRows = tracked.filter(item => {
        const createdAt = toDateOrNull(item.createdAt);
        return createdAt && createdAt >= day && createdAt < nextDay;
      });
      const dayCompleted = dayRows.filter(item => String(item.status || '').toLowerCase() === 'completed');
      const dayMet = dayCompleted.filter(item => item.slaStatus === 'met').length;
      const dayBreached = dayCompleted.filter(item => item.slaStatus === 'breached').length;

      return {
        date: day.toISOString().slice(0, 10),
        total: dayRows.length,
        met: dayMet,
        breached: dayBreached,
      };
    });

    res.json({
      days,
      generatedAt: new Date().toISOString(),
      totals: {
        tracked: tracked.length,
        completed: completed.length,
        met: metCount,
        completedBreached: completedBreachedCount,
        active: active.length,
        activeAtRisk: activeAtRiskCount,
        activeBreached: activeBreachedCount,
        complianceRate,
        averageResolutionMinutes,
      },
      byPriority,
      trend: lastSevenDays,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/activity', requireAuth, async (req, res) => {
  try {
    const request = await SupportRequest.findById(req.params.id).select('_id requestId');
    if (!request) return res.status(404).json({ error: 'Support request not found' });

    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 200);
    const skip = (page - 1) * limit;
    const filter = {
      entityType: 'support_request',
      entityId: request._id.toString(),
    };

    const [total, logs] = await Promise.all([
      Log.countDocuments(filter),
      Log.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
    ]);

    res.json({
      requestDbId: request._id.toString(),
      requestId: request.requestId,
      total,
      page,
      limit,
      activity: logs.map(fmtSupportLog),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/logs', requireAuth, async (req, res) => {
  try {
    const {
      requestDbId,
      requestId,
      type,
      search,
      page = 1,
      limit = 25,
    } = req.query;

    const safePage = Math.max(parseInt(page, 10) || 1, 1);
    const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 1), 200);
    const filter = { entityType: 'support_request' };

    if (type) filter.eventType = String(type).trim();

    const explicitEntityId = String(requestDbId || '').trim();
    if (explicitEntityId) {
      filter.entityId = explicitEntityId;
    } else if (requestId) {
      const normalizedRequestId = String(requestId).trim();
      const requestDoc = await SupportRequest.findOne({
        requestId: new RegExp(`^${escapeRegex(normalizedRequestId)}$`, 'i'),
      }).select('_id requestId');
      if (!requestDoc) {
        return res.json({ total: 0, page: safePage, limit: safeLimit, logs: [] });
      }
      filter.entityId = requestDoc._id.toString();
    }

    if (search) {
      const re = new RegExp(escapeRegex(String(search).slice(0, 200)), 'i');
      filter.$or = [
        { summary: re },
        { entityLabel: re },
        { actorName: re },
        { remarks: re },
        { 'changes.field': re },
        { 'changes.oldValue': re },
        { 'changes.newValue': re },
      ];
    }

    const skip = (safePage - 1) * safeLimit;
    const [total, logs] = await Promise.all([
      Log.countDocuments(filter),
      Log.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit),
    ]);

    res.json({
      total,
      page: safePage,
      limit: safeLimit,
      logs: logs.map(fmtSupportLog),
    });
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
    await logSupportRequestCreated(supportRequest, req.user?.name || req.user?.email || 'Support Admin', 'portal');

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
      if (body[field] !== undefined) {
        request[field] = field === 'priority' ? normalizePriority(body[field]) : body[field];
      }
    }
    await applySupportRequestUpdates(request, body);
    ensureCompletedOnboardingProvisioningReady(request);

    await request.save();
    await notifySupportRequestChanges(previousRequest, request);
    if (request.isModified()) await request.save();
    const slackPost = await postSupportRequestUpdateMessage(previousRequest, request, {
      source: 'support_center',
      actor: req.user?.name || req.user?.email || 'Support Admin',
    });
    await persistSlackThreadContext(request, slackPost);
    await syncCompletedOnboardingUser(request);
    await syncCompletedOffboardingUser(request);
    await logSupportRequestUpdated(previousRequest, request, req.user?.name || req.user?.email || 'Support Admin', 'support_center');
    res.json(fmtSupportRequest(request));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/:id', requireAuth, canWrite, async (req, res) => {
  try {
    const request = await SupportRequest.findByIdAndDelete(req.params.id);
    if (!request) return res.status(404).json({ error: 'Support request not found' });
    await logSupportRequestDeleted(request, req.user?.name || req.user?.email || 'Support Admin', 'support_center');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
