const mongoose = require('mongoose');
const SupportRequestType = require('./SupportRequestType');
const DEFAULT_SLA_POLICY = SupportRequestType.DEFAULT_SLA_POLICY || {
  enabled: true,
  responseMinutes: 60,
  resolutionMinutes: 480,
  atRiskPercent: 80,
};
const normalizeSlaPolicy = SupportRequestType.normalizeSlaPolicy
  || ((input = {}, fallback = DEFAULT_SLA_POLICY) => ({ ...fallback, ...input }));
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
const SLA_STATUS_VALUES = ['no_sla', 'on_track', 'at_risk', 'breached', 'met', 'paused'];

const WORKFLOW_TEMPLATES = Object.fromEntries(
  (SupportRequestType.DEFAULT_REQUEST_TYPE_DEFINITIONS || []).map(definition => [
    definition.workflowType,
    definition.checklist || [],
  ])
);

function buildChecklist(workflowType) {
  return (WORKFLOW_TEMPLATES[workflowType] || []).map(task => ({
    ...task,
    status: 'pending',
    provisioningMethod: '',
    connectorType: '',
    supportsDeprovision: false,
    provisioningNotes: '',
    handoffMessage: String(task.handoffMessage || '').trim(),
    owner: '',
    ownerUserId: '',
    ownerEmail: '',
    notes: '',
    completedAt: null,
    approvalMode: task.approvalMode === 'manager' ? 'manager' : 'none',
    approvalStatus: 'not_requested',
    approvalRequestedAt: null,
    approvalRespondedAt: null,
    approvalActorName: '',
    approvalActorEmail: '',
    approvalDecision: '',
    approvalTokenHash: '',
    approvalTokenExpiresAt: null,
  }));
}

const checklistItemSchema = new mongoose.Schema(
  {
    key:         { type: String, required: true, trim: true },
    label:       { type: String, required: true, trim: true },
    area:        { type: String, default: '', trim: true },
    softwareCsvId: { type: String, default: '', trim: true },
    provisioningMethod: { type: String, default: '', trim: true },
    connectorType: { type: String, default: '', trim: true },
    supportsDeprovision: { type: Boolean, default: false },
    provisioningNotes: { type: String, default: '', trim: true },
    handoffMessage: { type: String, default: '', trim: true },
    dependsOn:   { type: String, default: '', trim: true },
    status:      { type: String, enum: ['pending', 'done'], default: 'pending' },
    owner:       { type: String, default: '', trim: true },
    ownerUserId: { type: String, default: '', trim: true },
    ownerEmail:  { type: String, default: '', trim: true, lowercase: true },
    notes:       { type: String, default: '', trim: true },
    completedAt: { type: Date, default: null },
    approvalMode: { type: String, enum: ['none', 'manager'], default: 'none' },
    approvalStatus: {
      type: String,
      enum: ['not_requested', 'pending', 'approved', 'rejected'],
      default: 'not_requested',
    },
    approvalRequestedAt: { type: Date, default: null },
    approvalRespondedAt: { type: Date, default: null },
    approvalActorName: { type: String, default: '', trim: true },
    approvalActorEmail: { type: String, default: '', trim: true, lowercase: true },
    approvalDecision: { type: String, enum: ['', 'approve', 'reject'], default: '' },
    approvalTokenHash: { type: String, default: '', trim: true },
    approvalTokenExpiresAt: { type: Date, default: null },
  },
  { _id: false }
);

const requestApplicationSchema = new mongoose.Schema(
  {
    csvId: { type: String, default: '', trim: true },
    name: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const customFieldValueSchema = new mongoose.Schema(
  {
    key:   { type: String, required: true, trim: true },
    label: { type: String, default: '', trim: true },
    value: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const requestSlaPolicySnapshotSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: DEFAULT_SLA_POLICY.enabled },
    responseMinutes: { type: Number, default: DEFAULT_SLA_POLICY.responseMinutes, min: 1, max: 43200 },
    resolutionMinutes: { type: Number, default: DEFAULT_SLA_POLICY.resolutionMinutes, min: 1, max: 43200 },
    atRiskPercent: { type: Number, default: DEFAULT_SLA_POLICY.atRiskPercent, min: 1, max: 99 },
    priorityResponseMinutes: {
      low: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResponseMinutes?.low || 120), min: 1, max: 43200 },
      medium: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResponseMinutes?.medium || 60), min: 1, max: 43200 },
      high: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResponseMinutes?.high || 30), min: 1, max: 43200 },
    },
    priorityResolutionMinutes: {
      low: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.low || 120), min: 1, max: 43200 },
      medium: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.medium || 60), min: 1, max: 43200 },
      high: { type: Number, default: Number(DEFAULT_SLA_POLICY?.priorityResolutionMinutes?.high || 30), min: 1, max: 43200 },
    },
    breachReminderMinutes: { type: Number, default: Number(DEFAULT_SLA_POLICY?.breachReminderMinutes || 10), min: 1, max: 1440 },
    notifyAtRisk: { type: Boolean, default: DEFAULT_SLA_POLICY.notifyAtRisk !== false },
    notifyOnBreach: { type: Boolean, default: DEFAULT_SLA_POLICY.notifyOnBreach !== false },
    autoEscalateOnBreach: { type: Boolean, default: DEFAULT_SLA_POLICY.autoEscalateOnBreach !== false },
  },
  { _id: false }
);

function toDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasChecklistProgress(checklist = []) {
  return (Array.isArray(checklist) ? checklist : []).some(item => String(item?.status || '') === 'done');
}

function evaluateSla(doc) {
  const now = new Date();
  const createdAt = toDateOrNull(doc.createdAt) || now;
  const status = String(doc.status || '').toLowerCase();
  const priority = normalizePriority(doc.priority);
  const policy = normalizeSlaPolicy(doc.slaPolicySnapshot || {}, DEFAULT_SLA_POLICY);
  doc.slaPolicySnapshot = policy;

  if (!doc.firstResponseAt) {
    const hasRespondedStatus = ['in_progress', 'blocked', 'completed'].includes(status);
    if (hasRespondedStatus || hasChecklistProgress(doc.checklist || [])) {
      doc.firstResponseAt = now;
    }
  } else {
    doc.firstResponseAt = toDateOrNull(doc.firstResponseAt);
  }

  if (status === 'completed') {
    if (!doc.resolvedAt) doc.resolvedAt = now;
  } else {
    doc.resolvedAt = null;
  }

  if (!policy.enabled) {
    doc.slaResponseDueAt = null;
    doc.slaResolutionDueAt = null;
    doc.slaStatus = 'no_sla';
    doc.slaBreachedAt = null;
    return;
  }

  const responseMinutes = getSlaMinutesForPriority(policy, priority, 'response');
  const resolutionMinutes = getSlaMinutesForPriority(policy, priority, 'resolution');
  const responseDueAt = new Date(createdAt.getTime() + (Number(responseMinutes) * 60 * 1000));
  const resolutionDueAt = new Date(createdAt.getTime() + (Number(resolutionMinutes) * 60 * 1000));

  doc.slaResponseDueAt = responseDueAt;
  doc.slaResolutionDueAt = resolutionDueAt;

  let nextStatus = 'on_track';
  if (status === 'cancelled') {
    nextStatus = 'paused';
  } else if (status === 'completed') {
    const resolvedAt = toDateOrNull(doc.resolvedAt) || now;
    nextStatus = resolvedAt.getTime() > resolutionDueAt.getTime() ? 'breached' : 'met';
  } else if ((!doc.firstResponseAt && now.getTime() > responseDueAt.getTime()) || now.getTime() > resolutionDueAt.getTime()) {
    nextStatus = 'breached';
  } else {
    const totalMs = resolutionDueAt.getTime() - createdAt.getTime();
    const elapsedMs = now.getTime() - createdAt.getTime();
    const elapsedPercent = totalMs > 0 ? (elapsedMs / totalMs) * 100 : 100;
    nextStatus = elapsedPercent >= Number(policy.atRiskPercent || 80) ? 'at_risk' : 'on_track';
  }

  if (nextStatus === 'breached') {
    if (!doc.slaBreachedAt) doc.slaBreachedAt = now;
  } else {
    doc.slaBreachedAt = null;
  }

  doc.slaStatus = nextStatus;
}

const supportRequestSchema = new mongoose.Schema(
  {
    requestId: { type: String, unique: true, index: true },
    workflowType: {
      type: String,
      required: true,
      trim: true,
    },
    workflowLabel: { type: String, default: '', trim: true },
    sourceSystem: { type: String, default: 'portal', trim: true },
    sourceWorkflowSourceId: { type: String, default: '', trim: true },
    sourceWorkflowKey: { type: String, default: '', trim: true },
    requestedVia: { type: String, enum: ['portal', 'slack_command'], default: 'portal' },
    slackChannelId: { type: String, default: '', trim: true },
    slackMessageTs: { type: String, default: '', trim: true },
    slackThreadTs: { type: String, default: '', trim: true },
    slackTeamId: { type: String, default: '', trim: true },
    slackCommandUserId: { type: String, default: '', trim: true },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'blocked', 'completed', 'cancelled'],
      default: 'open',
      index: true,
    },
    priority: { type: String, enum: ['low', 'medium', 'high'], default: 'medium' },
    employeeName: { type: String, default: '', trim: true },
    employeeEmail: {
      type: String,
      default: '',
      lowercase: true,
      trim: true,
      validate: {
        validator(value) {
          return !value || /^\S+@\S+\.\S+$/.test(value);
        },
        message: 'Please enter a valid employee email address',
      },
    },
    department: { type: String, default: '', trim: true },
    jobTitle: { type: String, default: '', trim: true },
    location: { type: String, default: '', trim: true },
    managerName: { type: String, default: '', trim: true },
    managerUserId: { type: String, default: '', trim: true },
    managerEmail: { type: String, default: '', trim: true, lowercase: true },
    startDate: { type: String, default: '', trim: true },
    endDate: { type: String, default: '', trim: true },
    requestedById: { type: String, default: '', trim: true },
    requestedByName: { type: String, default: '', trim: true },
    requestedByEmail: { type: String, default: '', trim: true, lowercase: true },
    assignee: { type: String, default: '', trim: true },
    assigneeUserId: { type: String, default: '', trim: true },
    assigneeEmail: { type: String, default: '', trim: true, lowercase: true },
    applications: { type: [requestApplicationSchema], default: [] },
    notes: { type: String, default: '', trim: true },
    customFieldValues: { type: [customFieldValueSchema], default: [] },
    slaPolicySnapshot: { type: requestSlaPolicySnapshotSchema, default: () => ({ ...DEFAULT_SLA_POLICY }) },
    firstResponseAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    slaResponseDueAt: { type: Date, default: null },
    slaResolutionDueAt: { type: Date, default: null },
    slaStatus: { type: String, enum: SLA_STATUS_VALUES, default: 'on_track', index: true },
    slaBreachedAt: { type: Date, default: null },
    slaNotifiedAtRiskAt: { type: Date, default: null },
    slaNotifiedBreachAt: { type: Date, default: null },
    slaLastBreachReminderAt: { type: Date, default: null },
    slaEscalatedAt: { type: Date, default: null },
    checklist: { type: [checklistItemSchema], default: [] },
  },
  { timestamps: true }
);

supportRequestSchema.pre('validate', function () {
  if (!this.requestId) {
    this.requestId = `SUP-${Date.now().toString().slice(-6)}`;
  }
  if (!Array.isArray(this.checklist) || this.checklist.length === 0) {
    this.checklist = buildChecklist(this.workflowType);
  }
  for (const item of this.checklist) {
    if (item.status === 'done' && !item.completedAt) item.completedAt = new Date();
    if (item.status !== 'done') item.completedAt = null;
    item.approvalMode = item.approvalMode === 'manager' ? 'manager' : 'none';
    if (item.approvalMode === 'none') {
      item.approvalStatus = 'not_requested';
      item.approvalRequestedAt = null;
      item.approvalRespondedAt = null;
      item.approvalActorName = '';
      item.approvalActorEmail = '';
      item.approvalDecision = '';
      item.approvalTokenHash = '';
      item.approvalTokenExpiresAt = null;
    } else if (item.status === 'done') {
      item.approvalStatus = 'approved';
      item.approvalDecision = 'approve';
    } else if (item.approvalStatus === 'approved') {
      item.approvalStatus = 'pending';
      item.approvalDecision = '';
      item.approvalRespondedAt = null;
    }
  }
  evaluateSla(this);
});

supportRequestSchema.index({ workflowType: 1, status: 1 });
supportRequestSchema.index({ employeeEmail: 1 });
supportRequestSchema.index({ createdAt: -1 });

supportRequestSchema.statics.buildChecklist = buildChecklist;
supportRequestSchema.statics.workflowTemplates = WORKFLOW_TEMPLATES;

module.exports = mongoose.model('SupportRequest', supportRequestSchema);
