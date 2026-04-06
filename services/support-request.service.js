const { SupportRequest, SupportRequestType, Software, SlackWorkflowImport, User } = require('../db');

const ALL_DEPARTMENT_LABEL = 'All Departments';
const DEFAULT_REQUEST_TYPES = SupportRequestType.DEFAULT_REQUEST_TYPE_DEFINITIONS || [];
const REQUEST_TYPE_CLASSNAMES = SupportRequestType.REQUEST_TYPE_CLASSNAMES || [];
const REQUEST_FORM_FIELD_DEFINITIONS = SupportRequestType.REQUEST_FORM_FIELD_DEFINITIONS || [];
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
const normalizeWorkflowType = SupportRequestType.normalizeWorkflowType;
const DEFAULT_ASSIGNEE_WORKFLOW_TYPES = new Set(['app_hardware_issue', 'app_hardware_support']);
const REQUESTOR_ASSIGNEE_USER_ID = '__requestor__';
const REQUESTOR_ASSIGNEE_LABEL = 'Requestor';
const OFFBOARDING_APP_TASK_OPTIONS = {
  keyPrefix: 'app_revoke_',
  labelSuffix: 'access revoked',
  dependencyKeys: ['app_revoke', 'account_disable', 'manager_confirmation'],
};

const BUILTIN_WORKFLOW_META = Object.fromEntries(
  DEFAULT_REQUEST_TYPES.map(definition => [
    definition.workflowType,
    {
      label: definition.workflowLabel,
      className: definition.className,
      sourceSystem: 'portal',
    },
  ])
);

function fullName(user = {}) {
  return `${String(user.first || '').trim()} ${String(user.last || '').trim()}`.trim();
}

function normalizeSlaPolicyInput(input = {}, fallback = DEFAULT_SLA_POLICY) {
  return normalizeSlaPolicy(input, fallback);
}

function supportsRequestTypeDefaultAssignee({ workflowType = '', workflowLabel = '' } = {}) {
  const normalizedType = normalizeWorkflowType(workflowType);
  if (DEFAULT_ASSIGNEE_WORKFLOW_TYPES.has(normalizedType)) return true;
  return String(workflowLabel || '').trim().toLowerCase() === 'application and hardware support';
}

function isRequestorAssigneeRef(input = {}) {
  const userId = String(input.userId || input.id || '').trim();
  const name = String(input.name || input.label || input.value || '').trim().toLowerCase();
  if (userId === REQUESTOR_ASSIGNEE_USER_ID) return true;
  return name === REQUESTOR_ASSIGNEE_LABEL.toLowerCase();
}

function resolveRequestorRef(input = {}, userDirectory = null) {
  return resolveUserRef(
    {
      userId: input.userId || input.id || '',
      email: input.email || '',
      name: input.name || '',
    },
    userDirectory
  );
}

function applyRequestorChecklistOwners(checklist = [], requestorRef = {}) {
  return (Array.isArray(checklist) ? checklist : []).map(item => {
    if (!isRequestorAssigneeRef({ userId: item?.ownerUserId, name: item?.owner })) return item;
    return {
      ...item,
      owner: requestorRef.name || item.owner || '',
      ownerUserId: requestorRef.userId || '',
      ownerEmail: requestorRef.email || '',
    };
  });
}

function looksLikeEmail(value) {
  return /^\S+@\S+\.\S+$/.test(String(value || '').trim());
}

function normalizeLookupKey(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function normalizeUserSummary(user = {}) {
  const name = fullName(user);
  return {
    userId: user._id?.toString?.() || user.id || '',
    name,
    email: String(user.email || '').trim().toLowerCase(),
    status: String(user.status || '').trim(),
    department: String(user.dept || '').trim(),
    location: String(user.location || '').trim(),
    jobTitle: String(user.jobTitle || '').trim(),
    role: String(user.role || '').trim(),
    reportingManager: String(user.reportingManager || '').trim(),
    appAccess: Array.isArray(user.appAccess)
      ? [...new Set(user.appAccess.map(value => String(value || '').trim()).filter(Boolean))]
      : [],
  };
}

async function loadUserDirectory() {
  const users = await User.find({ status: 'Active' }).sort({ first: 1, last: 1 }).lean();
  const summaries = users
    .map(normalizeUserSummary)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();
  const byAlias = new Map();
  const aliasCollisions = new Set();

  function registerAlias(alias, summary) {
    const key = normalizeLookupKey(alias);
    if (!key) return;
    const existing = byAlias.get(key);
    if (existing) {
      if (String(existing.userId || '') === String(summary.userId || '')) return;
      aliasCollisions.add(key);
      return;
    }
    byAlias.set(key, summary);
  }

  summaries.forEach(summary => {
    if (summary.userId) byId.set(summary.userId, summary);
    if (summary.email) byEmail.set(summary.email, summary);
    if (summary.name) byName.set(summary.name.toLowerCase(), summary);
    if (summary.name) registerAlias(summary.name, summary);
    const emailLocalPart = String(summary.email || '').split('@')[0] || '';
    if (emailLocalPart) registerAlias(emailLocalPart, summary);
    const firstName = String(summary.name || '').split(/\s+/).filter(Boolean)[0] || '';
    if (firstName.length >= 3) registerAlias(firstName, summary);
  });

  aliasCollisions.forEach(alias => byAlias.delete(alias));
  return { users: summaries, byId, byEmail, byName, byAlias };
}

function resolveUserRef(input = {}, userDirectory = null) {
  const userId = String(input.userId || input.id || '').trim();
  const explicitEmail = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || input.label || input.value || '').trim();
  const extractedEmail = explicitEmail ? '' : extractEmailFromText(name);
  const email = explicitEmail || extractedEmail;

  if (isRequestorAssigneeRef({ userId, name })) {
    return {
      userId: REQUESTOR_ASSIGNEE_USER_ID,
      name: REQUESTOR_ASSIGNEE_LABEL,
      email: '',
      location: '',
      jobTitle: '',
      reportingManager: '',
      appAccess: [],
    };
  }

  if (userDirectory) {
    const lookupNameKey = normalizeLookupKey(name);
    const lookupEmailLocalKey = normalizeLookupKey(String(email || '').split('@')[0] || '');
    const matchedUser = (
      (userId && userDirectory.byId.get(userId))
      || (email && userDirectory.byEmail.get(email))
      || (name && userDirectory.byName.get(name.toLowerCase()))
      || (lookupNameKey && userDirectory.byAlias?.get(lookupNameKey))
      || (lookupEmailLocalKey && userDirectory.byAlias?.get(lookupEmailLocalKey))
    );
    if (matchedUser) return { ...matchedUser };
  }

  if (!name && email) {
    return { userId: '', name: email, email, location: '', jobTitle: '', reportingManager: '', appAccess: [] };
  }

  return {
    userId: userId || '',
    name,
    email,
    location: '',
    jobTitle: '',
    reportingManager: '',
    appAccess: [],
  };
}

function parseSoftwareDepartments(value) {
  const rawValues = Array.isArray(value) ? value : String(value || '').split(',');
  return [...new Set(rawValues.map(item => String(item || '').trim()).filter(Boolean))];
}

function normalizeSoftwareDepartmentList(values) {
  const list = parseSoftwareDepartments(values);
  return list.some(dept => {
    const normalized = String(dept || '').trim().toLowerCase();
    return normalized === ALL_DEPARTMENT_LABEL.toLowerCase() || normalized === 'all department';
  })
    ? [ALL_DEPARTMENT_LABEL]
    : list;
}

function matchesSoftwareDepartment(value, department) {
  const departments = normalizeSoftwareDepartmentList(value).map(item => item.toLowerCase());
  if (!departments.length) return false;
  if (departments.includes(ALL_DEPARTMENT_LABEL.toLowerCase())) return true;
  return departments.includes(String(department || '').trim().toLowerCase());
}

function softwareOwnerCandidates(software, userDirectory = null) {
  if (!software) return [];

  const rawCandidates = [
    ...String(software.admins || '')
      .split(/[,\n/;|]+/g)
      .map(value => value.trim())
      .filter(Boolean),
    software.owner,
  ];

  const unique = new Map();
  rawCandidates.forEach(value => {
    const summary = resolveUserRef(
      looksLikeEmail(value) ? { email: value, name: value } : { name: value },
      userDirectory
    );
    const key = summary.userId || summary.email || summary.name;
    if (key) unique.set(key.toLowerCase(), summary);
  });

  return [...unique.values()];
}

function softwareDefaultOwner(software, userDirectory = null) {
  return softwareOwnerCandidates(software, userDirectory)[0] || { userId: '', name: '', email: '' };
}

function extractEmailFromText(value) {
  const match = String(value || '').match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
  return match ? match[0].trim().toLowerCase() : '';
}

function splitEmployeeName(name, fallbackEmail = '') {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length) {
    return {
      first: parts[0],
      last: parts.slice(1).join(' '),
    };
  }

  const localPart = String(fallbackEmail || '').split('@')[0] || 'Employee';
  return {
    first: localPart,
    last: '',
  };
}

function normalizePortalLocation(value, fallback = 'USA') {
  const mapLocation = (raw) => {
    const normalized = String(raw || '').trim().toLowerCase();
    if (!normalized) return '';

    if (['chennai', 'india/chennai', 'india - chennai'].includes(normalized)) return 'Chennai';
    if (['coimbatore', 'india/coimbatore', 'india - coimbatore'].includes(normalized)) return 'Coimbatore';
    if (['usa', 'us', 'united states', 'remote', 'wfh'].includes(normalized)) return 'USA';
    if (['canada', 'can'].includes(normalized)) return 'Canada';

    return '';
  };

  return mapLocation(value) || mapLocation(fallback) || 'USA';
}

function parseJoinedDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function completedSoftwareAccessIds(request) {
  return [...new Set((request.checklist || [])
    .filter(item => item.softwareCsvId && item.status === 'done')
    .map(item => item.softwareCsvId))];
}

function onboardingWorkspaceEmail(request) {
  const step = (request.checklist || []).find(item => item.key === 'workspace_account')
    || (request.checklist || []).find(item => /google workspace account provisioned/i.test(String(item.label || '')));
  return extractEmailFromText(step?.notes || '');
}

function ensureCompletedOnboardingProvisioningReady(request) {
  if (request.workflowType !== 'onboarding' || request.status !== 'completed') return '';
  const email = onboardingWorkspaceEmail(request);
  if (!email) {
    throw new Error('Add the employee Google Workspace email to the "Google workspace account provisioned" step notes before completing onboarding.');
  }
  return email;
}

async function syncCompletedOnboardingUser(request) {
  if (request.workflowType !== 'onboarding' || request.status !== 'completed') return null;

  const workspaceEmail = ensureCompletedOnboardingProvisioningReady(request);
  const { first, last } = splitEmployeeName(request.employeeName, workspaceEmail);
  const appAccess = completedSoftwareAccessIds(request);
  const existingUser = await User.findOne({ email: workspaceEmail });

  if (existingUser) {
    existingUser.first = first || existingUser.first;
    existingUser.last = last;
    existingUser.reportingManager = String(request.managerName || existingUser.reportingManager || '').trim();
    existingUser.status = 'Active';
    existingUser.jobTitle = String(request.jobTitle || existingUser.jobTitle || '').trim();
    existingUser.dept = String(request.department || existingUser.dept || '').trim();
    existingUser.location = normalizePortalLocation(request.location, existingUser.location || 'USA');
    existingUser.joined = parseJoinedDate(request.startDate || existingUser.joined);
    existingUser.appAccess = [...new Set([...(existingUser.appAccess || []), ...appAccess])];
    await existingUser.save();
    return existingUser;
  }

  return User.create({
    first,
    last,
    email: workspaceEmail,
    role: 'Staff',
    reportingManager: String(request.managerName || '').trim(),
    status: 'Active',
    jobTitle: String(request.jobTitle || '').trim(),
    dept: String(request.department || '').trim(),
    location: normalizePortalLocation(request.location),
    joined: parseJoinedDate(request.startDate),
    appAccess,
  });
}

async function syncCompletedOffboardingUser(request) {
  if (request.workflowType !== 'offboarding' || request.status !== 'completed') return null;

  const email = String(request.employeeEmail || '').trim().toLowerCase();
  if (!email) return null;

  const user = await User.findOne({ email });
  if (!user) return null;

  user.status = 'Inactive';
  if (request.endDate) user.lastWorkingDate = new Date(request.endDate);
  await user.save();
  return user;
}

function sanitizeChecklist(input = []) {
  return input.map(item => ({
    key: String(item.key || '').trim(),
    label: String(item.label || '').trim(),
    area: String(item.area || '').trim(),
    handoffMessage: String(item.handoffMessage || '').trim(),
    softwareCsvId: String(item.softwareCsvId || '').trim(),
    provisioningMethod: String(item.provisioningMethod || '').trim(),
    connectorType: String(item.connectorType || '').trim(),
    supportsDeprovision: !!item.supportsDeprovision,
    provisioningNotes: String(item.provisioningNotes || '').trim(),
    dependsOn: String(item.dependsOn || '').trim(),
    status: item.status === 'done' ? 'done' : 'pending',
    owner: String(item.owner || '').trim(),
    ownerUserId: String(item.ownerUserId || '').trim(),
    ownerEmail: String(item.ownerEmail || '').trim().toLowerCase(),
    notes: String(item.notes || '').trim(),
    completedAt: item.status === 'done' ? (item.completedAt ? new Date(item.completedAt) : new Date()) : null,
    approvalMode: item.approvalMode === 'manager' ? 'manager' : 'none',
    approvalStatus: ['not_requested', 'pending', 'approved', 'rejected'].includes(item.approvalStatus) ? item.approvalStatus : 'not_requested',
    approvalRequestedAt: item.approvalRequestedAt ? new Date(item.approvalRequestedAt) : null,
    approvalRespondedAt: item.approvalRespondedAt ? new Date(item.approvalRespondedAt) : null,
    approvalActorName: String(item.approvalActorName || '').trim(),
    approvalActorEmail: String(item.approvalActorEmail || '').trim().toLowerCase(),
    approvalDecision: ['approve', 'reject'].includes(item.approvalDecision) ? item.approvalDecision : '',
    approvalTokenHash: String(item.approvalTokenHash || '').trim(),
    approvalTokenExpiresAt: item.approvalTokenExpiresAt ? new Date(item.approvalTokenExpiresAt) : null,
  }));
}

async function hydrateChecklistUsers(checklist = [], userDirectory = null) {
  const softwareIds = [...new Set(checklist.map(item => item.softwareCsvId).filter(Boolean))];
  const software = softwareIds.length
    ? await Software.find({ csvId: { $in: softwareIds } }).select('csvId owner admins provisioningMethod connectorType supportsDeprovision provisioningNotes').lean()
    : [];
  const softwareById = new Map(software.map(item => [item.csvId, item]));

  return checklist.map(item => {
    let ownerRef = resolveUserRef(
      {
        userId: item.ownerUserId,
        email: item.ownerEmail,
        name: item.owner,
      },
      userDirectory
    );

    if (!ownerRef.name && item.softwareCsvId) {
      ownerRef = softwareDefaultOwner(softwareById.get(item.softwareCsvId), userDirectory);
    }

    const softwareItem = item.softwareCsvId ? softwareById.get(item.softwareCsvId) : null;

    return {
      ...item,
      provisioningMethod: item.provisioningMethod || String(softwareItem?.provisioningMethod || '').trim(),
      connectorType: item.connectorType || String(softwareItem?.connectorType || '').trim(),
      supportsDeprovision: item.supportsDeprovision !== undefined ? !!item.supportsDeprovision : !!softwareItem?.supportsDeprovision,
      provisioningNotes: item.provisioningNotes || String(softwareItem?.provisioningNotes || '').trim(),
      owner: ownerRef.name || item.owner || '',
      ownerUserId: ownerRef.userId || '',
      ownerEmail: ownerRef.email || '',
    };
  });
}

function formatWorkflowTypeLabel(type) {
  return String(type || 'Unknown')
    .replace(/^slack:/, '')
    .replace(/[_:]+/g, ' ')
    .replace(/\b\w/g, char => char.toUpperCase());
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function sanitizeRequestTypeChecklist(input = []) {
  const seenKeys = new Set();
  const checklist = input
    .map((item, index) => {
      const key = slugify(item.key || item.label || `step_${index + 1}`) || `step_${index + 1}`;
      const uniqueKey = seenKeys.has(key) ? `${key}_${index + 1}` : key;
      seenKeys.add(uniqueKey);
      return {
        key: uniqueKey,
        label: String(item.label || '').trim(),
        area: String(item.area || '').trim(),
        handoffMessage: String(item.handoffMessage || '').trim(),
        dependsOn: String(item.dependsOn || '').trim(),
        defaultOwner: String(item.defaultOwner || '').trim(),
        defaultOwnerUserId: String(item.defaultOwnerUserId || '').trim(),
        defaultOwnerEmail: String(item.defaultOwnerEmail || '').trim().toLowerCase(),
        approvalMode: item.approvalMode === 'manager' ? 'manager' : 'none',
      };
    })
    .filter(item => item.label);

  const validKeys = new Set(checklist.map(item => item.key));
  return checklist.map(item => ({
    ...item,
    dependsOn: validKeys.has(item.dependsOn) ? item.dependsOn : '',
  }));
}

function normalizeRequestTypeFormFields(input = []) {
  const providedByKey = new Map((input || []).map(field => [String(field.key || '').trim(), field]));
  return REQUEST_FORM_FIELD_DEFINITIONS.map(field => {
    const override = providedByKey.get(field.key) || {};
    return {
      key: field.key,
      label: String(override.label || field.label).trim(),
      enabled: override.enabled === undefined ? field.enabledByDefault !== false : !!override.enabled,
      required: override.required === undefined ? !!field.required : !!override.required,
    };
  });
}

const CUSTOM_FORM_FIELD_TYPES = ['text', 'textarea', 'dropdown', 'file'];

function normalizeCustomFormFields(input = []) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input
    .map((field, index) => {
      const rawKey = String(field.key || field.label || `field_${index + 1}`).trim()
        .toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `field_${index + 1}`;
      const key = seen.has(rawKey) ? `${rawKey}_${index + 1}` : rawKey;
      seen.add(key);
      const type = CUSTOM_FORM_FIELD_TYPES.includes(field.type) ? field.type : 'text';
      const options = type === 'dropdown'
        ? (Array.isArray(field.options) ? field.options : [])
            .map(opt => ({ value: String(opt.value || opt.label || '').trim(), label: String(opt.label || opt.value || '').trim() }))
            .filter(opt => opt.value && opt.label)
        : [];
      return {
        key,
        label: String(field.label || '').trim() || key,
        type,
        required: !!field.required,
        options,
        sortOrder: Number(field.sortOrder ?? index),
      };
    })
    .filter(field => field.label);
}

function normalizeCustomFieldValues(input = []) {
  if (!Array.isArray(input)) return [];
  return input
    .map(item => ({
      key:   String(item.key   || '').trim(),
      label: String(item.label || '').trim(),
      value: String(item.value || '').trim(),
    }))
    .filter(item => item.key);
}

async function normalizeRequestedApplications(input = []) {
  const requestedIds = [...new Set((Array.isArray(input) ? input : [])
    .map(item => (typeof item === 'string' ? item : item?.csvId))
    .map(value => String(value || '').trim())
    .filter(Boolean))];
  if (!requestedIds.length) return [];

  const software = await Software.find({ csvId: { $in: requestedIds } })
    .select('csvId name status')
    .lean();
  const softwareById = new Map(software.map(item => [item.csvId, item]));

  return requestedIds
    .map(csvId => softwareById.get(csvId))
    .filter(app => app?.csvId && app?.name)
    .map(app => ({
      csvId: app.csvId,
      name: app.name,
    }));
}

async function resolveRequestTypePeople(input = {}, userDirectory = null) {
  const defaultAssignee = resolveUserRef(
    {
      userId: input.defaultAssigneeUserId,
      email: input.defaultAssigneeEmail,
      name: input.defaultAssignee,
    },
    userDirectory
  );

  const checklist = sanitizeRequestTypeChecklist(input.checklist || []).map(step => {
    const owner = resolveUserRef(
      {
        userId: step.defaultOwnerUserId,
        email: step.defaultOwnerEmail,
        name: step.defaultOwner,
      },
      userDirectory
    );
    return {
      ...step,
      defaultOwner: owner.name || step.defaultOwner || '',
      defaultOwnerUserId: owner.userId || '',
      defaultOwnerEmail: owner.email || '',
    };
  });

  return {
    defaultAssignee: defaultAssignee.name || String(input.defaultAssignee || '').trim(),
    defaultAssigneeUserId: defaultAssignee.userId || '',
    defaultAssigneeEmail: defaultAssignee.email || '',
    checklist,
  };
}

function formatRequestTypeDefinition(doc) {
  const source = doc.toObject ? doc.toObject() : { ...doc };
  const allowDefaultAssignee = supportsRequestTypeDefaultAssignee({
    workflowType: source.workflowType,
    workflowLabel: source.workflowLabel,
  });
  const hasRequestorDefaultAssignee = isRequestorAssigneeRef({
    userId: source.defaultAssigneeUserId,
    name: source.defaultAssignee,
  });
  return {
    id: source._id?.toString?.() || source.id || '',
    workflowType: source.workflowType,
    workflowLabel: source.workflowLabel,
    description: source.description || '',
    className: source.className || 'new-app',
    sourceSystem: source.sourceSystem || 'portal',
    sourceWorkflowSourceId: source.sourceWorkflowSourceId || '',
    sourceWorkflowKey: source.sourceWorkflowKey || source.workflowType,
    sortOrder: Number(source.sortOrder || 0),
    isActive: source.isActive !== false,
    defaultAssignee: allowDefaultAssignee && !hasRequestorDefaultAssignee ? (source.defaultAssignee || '') : '',
    defaultAssigneeUserId: allowDefaultAssignee && !hasRequestorDefaultAssignee ? (source.defaultAssigneeUserId || '') : '',
    defaultAssigneeEmail: allowDefaultAssignee && !hasRequestorDefaultAssignee ? (source.defaultAssigneeEmail || '') : '',
    autoAddDepartmentApps: !!source.autoAddDepartmentApps,
    isSystem: !!source.isSystem,
    slaPolicy: normalizeSlaPolicyInput(source.slaPolicy || {}, DEFAULT_SLA_POLICY),
    formFields: normalizeRequestTypeFormFields(source.formFields || []),
    customFormFields: normalizeCustomFormFields(source.customFormFields || []),
    checklist: sanitizeRequestTypeChecklist(source.checklist || []),
    stepCount: Array.isArray(source.checklist) ? source.checklist.length : 0,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}

async function ensureDefaultRequestTypes() {
  const existing = await SupportRequestType.find().lean();
  const existingTypes = new Set(existing.map(item => item.workflowType));
  const missing = DEFAULT_REQUEST_TYPES.filter(definition => !existingTypes.has(definition.workflowType));
  if (missing.length) {
    await SupportRequestType.insertMany(missing.map(definition => ({
      ...definition,
      isSystem: true,
      sourceSystem: 'portal',
      sourceWorkflowKey: definition.workflowType,
    })));
  }

  const defaultByType = new Map(DEFAULT_REQUEST_TYPES.map(definition => [definition.workflowType, definition]));
  await Promise.all(existing.map(async item => {
    const defaults = defaultByType.get(item.workflowType);
    if (!defaults) return;

    let changed = false;
    const normalizedSlaPolicy = normalizeSlaPolicyInput(item.slaPolicy || {}, defaults.slaPolicy || DEFAULT_SLA_POLICY);
    const hasSlaDelta = (
      !item.slaPolicy
      || item.slaPolicy.enabled !== normalizedSlaPolicy.enabled
      || Number(item.slaPolicy.responseMinutes) !== Number(normalizedSlaPolicy.responseMinutes)
      || Number(item.slaPolicy.resolutionMinutes) !== Number(normalizedSlaPolicy.resolutionMinutes)
      || Number(item.slaPolicy.atRiskPercent) !== Number(normalizedSlaPolicy.atRiskPercent)
      || Number(item?.slaPolicy?.priorityResponseMinutes?.low) !== Number(normalizedSlaPolicy?.priorityResponseMinutes?.low)
      || Number(item?.slaPolicy?.priorityResponseMinutes?.medium) !== Number(normalizedSlaPolicy?.priorityResponseMinutes?.medium)
      || Number(item?.slaPolicy?.priorityResponseMinutes?.high) !== Number(normalizedSlaPolicy?.priorityResponseMinutes?.high)
      || Number(item?.slaPolicy?.priorityResolutionMinutes?.low) !== Number(normalizedSlaPolicy?.priorityResolutionMinutes?.low)
      || Number(item?.slaPolicy?.priorityResolutionMinutes?.medium) !== Number(normalizedSlaPolicy?.priorityResolutionMinutes?.medium)
      || Number(item?.slaPolicy?.priorityResolutionMinutes?.high) !== Number(normalizedSlaPolicy?.priorityResolutionMinutes?.high)
      || Number(item?.slaPolicy?.breachReminderMinutes) !== Number(normalizedSlaPolicy?.breachReminderMinutes)
      || Boolean(item?.slaPolicy?.notifyAtRisk) !== Boolean(normalizedSlaPolicy?.notifyAtRisk)
      || Boolean(item?.slaPolicy?.notifyOnBreach) !== Boolean(normalizedSlaPolicy?.notifyOnBreach)
      || Boolean(item?.slaPolicy?.autoEscalateOnBreach) !== Boolean(normalizedSlaPolicy?.autoEscalateOnBreach)
    );
    if (hasSlaDelta) changed = true;

    const checklist = (item.checklist || []).map(step => {
      const defaultStep = (defaults.checklist || []).find(candidate => candidate.key === step.key);
      if (!defaultStep || step.approvalMode) return step;
      changed = true;
      return {
        ...step,
        approvalMode: defaultStep.approvalMode === 'manager' ? 'manager' : 'none',
      };
    });

    const existingFormFields = Array.isArray(item.formFields) ? item.formFields : [];
    const existingKeys = new Set(existingFormFields.map(field => field.key));
    const normalizedDefaults = normalizeRequestTypeFormFields(defaults.formFields || []);
    const nextFormFields = [...existingFormFields];

    normalizedDefaults.forEach(field => {
      if (!existingKeys.has(field.key)) {
        nextFormFields.push(field);
      }
    });

    if (item.workflowType === 'application_access') {
      nextFormFields.forEach(field => {
        if (field.key === 'applications') {
          if (!field.enabled || !field.required) changed = true;
          field.enabled = true;
          field.required = true;
        }
      });
    } else if (item.workflowType === 'offboarding') {
      nextFormFields.forEach(field => {
        if (field.key === 'applications') {
          if (!field.enabled || field.required) changed = true;
          field.enabled = true;
          field.required = false;
        }
      });
    }

    if (nextFormFields.length !== existingFormFields.length) changed = true;
    if (changed) {
      await SupportRequestType.updateOne({
        _id: item._id,
      }, {
        $set: {
          checklist,
          formFields: nextFormFields,
          slaPolicy: normalizedSlaPolicy,
        },
      });
    }
  }));
}

async function listRequestTypeDefinitions() {
  await ensureDefaultRequestTypes();
  const requestTypes = await SupportRequestType.find().sort({ sortOrder: 1, workflowLabel: 1 });
  return requestTypes.map(formatRequestTypeDefinition);
}

async function getRequestTypeDefinition(workflowType) {
  await ensureDefaultRequestTypes();
  const normalized = normalizeWorkflowType(workflowType);
  if (!normalized) return null;
  const requestType = await SupportRequestType.findOne({ workflowType: normalized }).lean();
  return requestType ? formatRequestTypeDefinition(requestType) : null;
}

async function createRequestTypeDefinition(input = {}) {
  await ensureDefaultRequestTypes();
  const workflowType = normalizeWorkflowType(input.workflowType);
  if (!workflowType) throw new Error('Request type key is required.');

  if (!String(input.workflowLabel || '').trim()) throw new Error('Request type label is required.');

  const userDirectory = await loadUserDirectory();
  const people = await resolveRequestTypePeople(input, userDirectory);
  const autoAddDepartmentApps = !!input.autoAddDepartmentApps;
  const allowDefaultAssignee = supportsRequestTypeDefaultAssignee({
    workflowType,
    workflowLabel: input.workflowLabel,
  });
  const hasRequestorDefaultAssignee = isRequestorAssigneeRef({
    userId: people.defaultAssigneeUserId,
    name: people.defaultAssignee,
  });
  const formFields = normalizeRequestTypeFormFields(input.formFields || []).map(field => (
    field.key === 'department' && autoAddDepartmentApps
      ? { ...field, enabled: true, required: true }
      : field
  ));
  if (!people.checklist.length) throw new Error('Add at least one workflow step.');

  const created = await SupportRequestType.create({
    workflowType,
    workflowLabel: String(input.workflowLabel || '').trim(),
    description: String(input.description || '').trim(),
    className: REQUEST_TYPE_CLASSNAMES.includes(input.className) ? input.className : 'new-app',
    sourceSystem: 'portal',
    sourceWorkflowSourceId: '',
    sourceWorkflowKey: workflowType,
    sortOrder: Number(input.sortOrder || 0),
    isActive: input.isActive !== false,
    defaultAssignee: allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssignee : '',
    defaultAssigneeUserId: allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssigneeUserId : '',
    defaultAssigneeEmail: allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssigneeEmail : '',
    autoAddDepartmentApps,
    slaPolicy: normalizeSlaPolicyInput(input.slaPolicy || {}, DEFAULT_SLA_POLICY),
    formFields,
    customFormFields: normalizeCustomFormFields(input.customFormFields || []),
    checklist: people.checklist,
  });

  return formatRequestTypeDefinition(created);
}

async function updateRequestTypeDefinition(id, input = {}) {
  await ensureDefaultRequestTypes();
  const requestType = await SupportRequestType.findById(id);
  if (!requestType) throw new Error('Request type not found.');

  const userDirectory = await loadUserDirectory();
  const people = await resolveRequestTypePeople(input, userDirectory);
  if (!people.checklist.length) throw new Error('Add at least one workflow step.');
  const allowDefaultAssignee = supportsRequestTypeDefaultAssignee({
    workflowType: requestType.workflowType,
    workflowLabel: input.workflowLabel || requestType.workflowLabel,
  });
  const hasRequestorDefaultAssignee = isRequestorAssigneeRef({
    userId: people.defaultAssigneeUserId,
    name: people.defaultAssignee,
  });

  if (String(input.workflowLabel || '').trim()) requestType.workflowLabel = String(input.workflowLabel).trim();
  requestType.description = String(input.description || '').trim();
  requestType.className = REQUEST_TYPE_CLASSNAMES.includes(input.className) ? input.className : requestType.className;
  requestType.sortOrder = Number(input.sortOrder || 0);
  requestType.isActive = input.isActive !== false;
  requestType.defaultAssignee = allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssignee : '';
  requestType.defaultAssigneeUserId = allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssigneeUserId : '';
  requestType.defaultAssigneeEmail = allowDefaultAssignee && !hasRequestorDefaultAssignee ? people.defaultAssigneeEmail : '';
  requestType.autoAddDepartmentApps = !!input.autoAddDepartmentApps;
  requestType.slaPolicy = normalizeSlaPolicyInput(
    input.slaPolicy || requestType.slaPolicy || {},
    requestType.slaPolicy || DEFAULT_SLA_POLICY
  );
  requestType.formFields = normalizeRequestTypeFormFields(input.formFields || []).map(field => (
    field.key === 'department' && requestType.autoAddDepartmentApps
      ? { ...field, enabled: true, required: true }
      : field
  ));
  requestType.customFormFields = normalizeCustomFormFields(input.customFormFields || []);
  requestType.checklist = people.checklist;

  await requestType.save();
  return formatRequestTypeDefinition(requestType);
}

async function deleteRequestTypeDefinition(id) {
  await ensureDefaultRequestTypes();
  const requestType = await SupportRequestType.findById(id);
  if (!requestType) throw new Error('Request type not found.');
  if (requestType.isSystem) {
    throw new Error('System request types cannot be deleted. Disable this request type instead.');
  }

  await requestType.deleteOne();
  return {
    id: requestType._id?.toString?.() || String(id),
    workflowType: requestType.workflowType,
    workflowLabel: requestType.workflowLabel,
  };
}

function buildSlackChecklist(workflow) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (!steps.length) {
    return [
      {
        key: 'workflow_review',
        label: `Review imported workflow${workflow?.title ? `: ${workflow.title}` : ''}`,
        area: 'Slack Workflow',
        handoffMessage: '',
        softwareCsvId: '',
        dependsOn: '',
        status: 'pending',
        owner: '',
        ownerUserId: '',
        ownerEmail: '',
        notes: '',
        completedAt: null,
        approvalMode: 'none',
      },
    ];
  }

  return steps.map((step, index) => {
    const stepType = step?.type || step?.function || step?.name || step?.id || `step_${index + 1}`;
    const stepLabel = step?.title || step?.name || step?.display_name || stepType;
    return {
      key: slugify(step?.id || `${workflow?.key || 'workflow'}_${index + 1}_${stepType}`) || `step_${index + 1}`,
      label: String(stepLabel || `Step ${index + 1}`),
      area: 'Slack Workflow',
      handoffMessage: '',
      softwareCsvId: '',
      dependsOn: '',
      status: 'pending',
      owner: '',
      ownerUserId: '',
      ownerEmail: '',
      notes: stepType ? `Imported from Slack step type: ${stepType}` : '',
      completedAt: null,
      approvalMode: 'none',
    };
  });
}

async function getSlackWorkflowDefinition(workflowType) {
  if (!String(workflowType || '').startsWith('slack:')) return null;

  const [, sourceAppId = '', workflowKey = ''] = String(workflowType).split(':');
  if (!sourceAppId || !workflowKey) return null;

  const imported = await SlackWorkflowImport.findOne({ sourceAppId }).lean();
  if (!imported) return null;

  const workflow = (imported.workflows || []).find(item => item.key === workflowKey || item.callbackId === workflowKey);
  if (!workflow) return null;

  return {
    workflowType: `slack:${sourceAppId}:${workflow.key}`,
    workflowLabel: workflow.title || formatWorkflowTypeLabel(workflowKey),
    className: 'application-access',
    sourceSystem: 'slack',
    sourceWorkflowSourceId: sourceAppId,
    sourceWorkflowKey: workflow.key,
    defaultAssignee: '',
    defaultAssigneeUserId: '',
    defaultAssigneeEmail: '',
    autoAddDepartmentApps: false,
    slaPolicy: normalizeSlaPolicyInput({}, DEFAULT_SLA_POLICY),
    formFields: normalizeRequestTypeFormFields([]),
    checklist: buildSlackChecklist(workflow),
  };
}

async function resolveWorkflowDefinition(workflowType) {
  const requestType = await getRequestTypeDefinition(workflowType);
  if (requestType) {
    return {
      workflowType: requestType.workflowType,
      workflowLabel: requestType.workflowLabel,
      className: requestType.className,
      sourceSystem: requestType.sourceSystem || 'portal',
      sourceWorkflowSourceId: requestType.sourceWorkflowSourceId || '',
      sourceWorkflowKey: requestType.sourceWorkflowKey || requestType.workflowType,
      defaultAssignee: requestType.defaultAssignee || '',
      defaultAssigneeUserId: requestType.defaultAssigneeUserId || '',
      defaultAssigneeEmail: requestType.defaultAssigneeEmail || '',
      autoAddDepartmentApps: !!requestType.autoAddDepartmentApps,
      slaPolicy: normalizeSlaPolicyInput(requestType.slaPolicy || {}, DEFAULT_SLA_POLICY),
      formFields: normalizeRequestTypeFormFields(requestType.formFields || []),
      checklist: requestType.checklist || [],
    };
  }

  const slackDefinition = await getSlackWorkflowDefinition(workflowType);
  if (slackDefinition) return slackDefinition;

  throw new Error(`Unknown workflow type: ${workflowType}`);
}

async function buildChecklistForCreate(body = {}, workflow = null, userDirectory = null) {
  const activeWorkflow = workflow || await resolveWorkflowDefinition(body.workflowType);
  if (Array.isArray(body.checklist) && body.checklist.length) {
    return hydrateChecklistUsers(sanitizeChecklist(body.checklist), userDirectory);
  }

  const checklist = await hydrateChecklistUsers(
    sanitizeChecklist((activeWorkflow.checklist || []).map(step => ({
      ...step,
      handoffMessage: step.handoffMessage || '',
      owner: step.defaultOwner || '',
      ownerUserId: step.defaultOwnerUserId || '',
      ownerEmail: step.defaultOwnerEmail || '',
      approvalMode: step.approvalMode || 'none',
    }))),
    userDirectory
  );
  if (!activeWorkflow.autoAddDepartmentApps || !body.department) return checklist;

  const apps = (await Software.find({ status: 'Active' })
    .sort({ name: 1 })
    .select('csvId name owner admins department provisioningMethod connectorType supportsDeprovision provisioningNotes')
    .lean())
    .filter(app => matchesSoftwareDepartment(app.department, body.department));

  const existingKeys = new Set(checklist.map(item => item.key));
  const dependencyKey = checklist.find(item => item.key === 'workspace_account') ? 'workspace_account' : '';
  const appTasks = apps
    .filter(app => app?.csvId && app?.name)
    .map(app => {
      const owner = softwareDefaultOwner(app, userDirectory);
      return {
        key: `app_access_${String(app.csvId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        label: `${app.name} access granted`,
        area: 'Applications',
        softwareCsvId: app.csvId,
        provisioningMethod: app.provisioningMethod || 'Manual',
        connectorType: app.connectorType || '',
        supportsDeprovision: !!app.supportsDeprovision,
        provisioningNotes: app.provisioningNotes || '',
        dependsOn: dependencyKey,
        status: 'pending',
        handoffMessage: '',
        owner: owner.name || '',
        ownerUserId: owner.userId || '',
        ownerEmail: owner.email || '',
        notes: '',
        completedAt: null,
        approvalMode: 'none',
      };
    })
    .filter(task => !existingKeys.has(task.key));

  return [...checklist, ...appTasks];
}

async function addRequestedApplicationTasks(checklist = [], applications = [], userDirectory = null, options = {}) {
  if (!applications.length) return checklist;

  const keyPrefix = String(options.keyPrefix || 'app_access_');
  const labelSuffix = String(options.labelSuffix || 'access granted').trim() || 'access granted';
  const dependencyKeys = Array.isArray(options.dependencyKeys) && options.dependencyKeys.length
    ? options.dependencyKeys
    : ['approval_recorded', 'access_review'];

  const software = await Software.find({ csvId: { $in: applications.map(app => app.csvId) } })
    .select('csvId name owner admins provisioningMethod connectorType supportsDeprovision provisioningNotes')
    .lean();
  const softwareById = new Map(software.map(item => [item.csvId, item]));
  const existingKeys = new Set(checklist.map(item => item.key));
  const dependencyKey = dependencyKeys
    .map(key => checklist.find(item => item.key === key)?.key || '')
    .find(Boolean) || '';

  const appTasks = applications
    .map(app => {
      const softwareItem = softwareById.get(app.csvId);
      const owner = softwareDefaultOwner(softwareItem, userDirectory);
      return {
        key: `${keyPrefix}${String(app.csvId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        label: `${app.name} ${labelSuffix}`,
        area: 'Applications',
        softwareCsvId: app.csvId,
        provisioningMethod: softwareItem?.provisioningMethod || 'Manual',
        connectorType: softwareItem?.connectorType || '',
        supportsDeprovision: !!softwareItem?.supportsDeprovision,
        provisioningNotes: softwareItem?.provisioningNotes || '',
        dependsOn: dependencyKey,
        status: 'pending',
        handoffMessage: '',
        owner: owner.name || '',
        ownerUserId: owner.userId || '',
        ownerEmail: owner.email || '',
        notes: '',
        approvalMode: 'none',
      };
    })
    .filter(task => !existingKeys.has(task.key));

  return [...checklist, ...appTasks];
}

async function syncRequestedApplicationTasks(checklist = [], applications = [], userDirectory = null, options = {}) {
  const keyPrefix = String(options.keyPrefix || 'app_access_');
  const preservedSteps = checklist.filter(item => !(item.softwareCsvId && item.key.startsWith(keyPrefix)));
  const existingAppSteps = new Map(
    checklist
      .filter(item => item.softwareCsvId && item.key.startsWith(keyPrefix))
      .map(item => [item.softwareCsvId, item])
  );

  const withRequestedApps = await addRequestedApplicationTasks(preservedSteps, applications, userDirectory, options);
  return withRequestedApps.map(item => {
    if (!item.softwareCsvId || !existingAppSteps.has(item.softwareCsvId)) return item;
    const existing = existingAppSteps.get(item.softwareCsvId);
    return {
      ...item,
      status: existing.status,
      owner: existing.owner || item.owner,
      ownerUserId: existing.ownerUserId || item.ownerUserId,
      ownerEmail: existing.ownerEmail || item.ownerEmail,
      notes: existing.notes || '',
      completedAt: existing.completedAt || null,
    };
  });
}

function hasExplicitAssigneeInput(body = {}) {
  return ['assignee', 'assigneeUserId', 'assigneeEmail']
    .some(key => String(body[key] || '').trim().length > 0);
}

function resolveReportingManagerRef(userRef = {}, userDirectory = null) {
  const managerName = String(userRef?.reportingManager || '').trim();
  if (!managerName) return null;

  const resolved = resolveUserRef({ name: managerName }, userDirectory);
  if (resolved.userId || resolved.email || resolved.name) return resolved;

  return {
    userId: '',
    name: managerName,
    email: '',
    reportingManager: '',
  };
}

function applyManagerApprovalStepOwners(checklist = [], managerRef = {}, options = {}) {
  const managerUserId = String(managerRef?.userId || '').trim();
  const managerEmail = String(managerRef?.email || '').trim().toLowerCase();
  const managerName = String(managerRef?.name || '').trim();
  if (!managerUserId && !managerEmail && !managerName) return checklist;
  const overwrite = !!options.overwrite;

  return (Array.isArray(checklist) ? checklist : []).map(step => {
    if (String(step?.approvalMode || 'none') !== 'manager') return step;
    if (String(step?.status || 'pending') === 'done') return step;

    const hasOwner = !!(
      String(step?.ownerUserId || '').trim()
      || String(step?.ownerEmail || '').trim()
      || String(step?.owner || '').trim()
    );
    if (hasOwner && !overwrite) return step;

    return {
      ...step,
      owner: managerName || String(step?.owner || '').trim(),
      ownerUserId: managerUserId || '',
      ownerEmail: managerEmail || '',
    };
  });
}

function resolveManagerApprovalDefaultAssignee({
  body = {},
  actor = {},
  manager = {},
  requiresManagerApproval = false,
  userDirectory = null,
} = {}) {
  if (!requiresManagerApproval) return null;
  if (hasExplicitAssigneeInput(body)) return null;

  const requesterRef = resolveUserRef(
    {
      userId: actor.id,
      email: actor.email,
      name: actor.name,
    },
    userDirectory
  );
  const employeeRef = resolveUserRef(
    {
      email: body.employeeEmail,
      name: body.employeeName,
    },
    userDirectory
  );

  const candidates = [
    resolveReportingManagerRef(requesterRef, userDirectory),
    resolveReportingManagerRef(employeeRef, userDirectory),
    (manager.userId || manager.email || manager.name) ? manager : null,
  ].filter(Boolean);

  return candidates[0] || null;
}

function resolveConfiguredWorkflowAssignee(workflow = {}, userDirectory = null) {
  const workflowAssigneeRef = {
    userId: workflow.defaultAssigneeUserId,
    email: workflow.defaultAssigneeEmail,
    name: workflow.defaultAssignee,
  };
  if (isRequestorAssigneeRef(workflowAssigneeRef)) {
    return { userId: '', name: '', email: '', reportingManager: '', appAccess: [], department: '', location: '', jobTitle: '' };
  }
  return resolveUserRef(workflowAssigneeRef, userDirectory);
}

function resolveEmployeeProfile(body = {}, userDirectory = null) {
  return resolveUserRef(
    {
      email: body.employeeEmail,
      name: body.employeeName,
    },
    userDirectory
  );
}

async function resolveSupportRequestApplications(body = {}, workflow = {}, userDirectory = null, employeeProfile = null) {
  const requestedApplications = await normalizeRequestedApplications(body.applications || []);
  if (requestedApplications.length) return requestedApplications;
  if (workflow.workflowType !== 'offboarding') return requestedApplications;

  const employee = employeeProfile || resolveEmployeeProfile(body, userDirectory);
  const employeeAppAccess = Array.isArray(employee.appAccess) ? employee.appAccess : [];
  if (!employeeAppAccess.length) return requestedApplications;

  return normalizeRequestedApplications(employeeAppAccess);
}

async function createSupportRequest(body = {}, actor = {}, options = {}) {
  const userDirectory = await loadUserDirectory();
  const workflow = await resolveWorkflowDefinition(body.workflowType);
  const slackContext = options.slackContext || {};
  const requestorRef = resolveRequestorRef(actor, userDirectory);
  const employeeProfile = resolveEmployeeProfile(body, userDirectory);
  const applications = await resolveSupportRequestApplications(body, workflow, userDirectory, employeeProfile);
  const employeeName = String(body.employeeName || '').trim() || employeeProfile.name || '';
  const employeeEmail = String(body.employeeEmail || '').trim().toLowerCase() || employeeProfile.email || '';
  const department = String(body.department || '').trim() || employeeProfile.department || '';
  const jobTitle = String(body.jobTitle || '').trim() || employeeProfile.jobTitle || '';
  const location = String(body.location || '').trim() || employeeProfile.location || '';
  let checklist = await buildChecklistForCreate(body, workflow, userDirectory);
  if (workflow.workflowType === 'application_access') {
    checklist = await addRequestedApplicationTasks(checklist, applications, userDirectory);
  } else if (workflow.workflowType === 'offboarding') {
    checklist = await addRequestedApplicationTasks(checklist, applications, userDirectory, OFFBOARDING_APP_TASK_OPTIONS);
  }
  checklist = applyRequestorChecklistOwners(checklist, requestorRef);
  const requiresManagerApproval = checklist.some(item => item?.approvalMode === 'manager');

  let manager = resolveUserRef(
    {
      userId: body.managerUserId,
      email: body.managerEmail,
      name: body.managerName || employeeProfile.reportingManager,
    },
    userDirectory
  );
  if (!manager.userId && !manager.email && !manager.name) {
    manager = resolveReportingManagerRef(employeeProfile, userDirectory)
      || resolveReportingManagerRef(requestorRef, userDirectory)
      || manager;
  }
  checklist = applyManagerApprovalStepOwners(checklist, manager, { overwrite: true });
  const defaultAssignee = resolveManagerApprovalDefaultAssignee({
    body,
    actor,
    manager,
    requiresManagerApproval,
    userDirectory,
  });
  const workflowAssignee = resolveConfiguredWorkflowAssignee(workflow, userDirectory);
  const assignee = resolveUserRef(
    {
      userId: body.assigneeUserId || workflowAssignee.userId || defaultAssignee?.userId,
      email: body.assigneeEmail || workflowAssignee.email || defaultAssignee?.email,
      name: body.assignee || workflowAssignee.name || defaultAssignee?.name,
    },
    userDirectory
  );

  return SupportRequest.create({
    workflowType: workflow.workflowType,
    workflowLabel: body.workflowLabel || workflow.workflowLabel,
    sourceSystem: workflow.sourceSystem,
    sourceWorkflowSourceId: workflow.sourceWorkflowSourceId || '',
    sourceWorkflowKey: workflow.sourceWorkflowKey || '',
    requestedVia: options.requestedVia || 'portal',
    slackChannelId: String(slackContext.channelId || body.slackChannelId || '').trim(),
    slackMessageTs: String(slackContext.messageTs || body.slackMessageTs || '').trim(),
    slackThreadTs: String(slackContext.threadTs || body.slackThreadTs || '').trim(),
    slackTeamId: String(slackContext.teamId || body.slackTeamId || '').trim(),
    slackCommandUserId: String(slackContext.commandUserId || actor.id || '').trim(),
    priority: normalizePriority(body.priority || 'medium'),
    employeeName: employeeName,
    employeeEmail: employeeEmail,
    department: department,
    jobTitle: jobTitle,
    location: location,
    managerName: manager.name || String(body.managerName || employeeProfile.reportingManager || '').trim(),
    managerUserId: manager.userId || '',
    managerEmail: manager.email || String(body.managerEmail || '').trim().toLowerCase(),
    startDate: body.startDate || '',
    endDate: body.endDate || '',
    notes: body.notes || '',
    customFieldValues: normalizeCustomFieldValues(body.customFieldValues || []),
    assignee: assignee.name || String(body.assignee || '').trim(),
    assigneeUserId: assignee.userId || '',
    assigneeEmail: assignee.email || String(body.assigneeEmail || '').trim().toLowerCase(),
    applications,
    requestedById: actor.id || '',
    requestedByName: actor.name || '',
    requestedByEmail: actor.email || '',
    slaPolicySnapshot: normalizeSlaPolicyInput(workflow.slaPolicy || {}, DEFAULT_SLA_POLICY),
    checklist,
  });
}

async function applySupportRequestUpdates(request, body = {}) {
  const userDirectory = await loadUserDirectory();
  const requestorRef = resolveRequestorRef(
    {
      userId: request.requestedById,
      email: request.requestedByEmail,
      name: request.requestedByName,
    },
    userDirectory
  );

  let manager = resolveUserRef(
    {
      userId: body.managerUserId !== undefined ? body.managerUserId : request.managerUserId,
      email: body.managerEmail !== undefined ? body.managerEmail : request.managerEmail,
      name: body.managerName !== undefined ? body.managerName : request.managerName,
    },
    userDirectory
  );
  if (!manager.userId && !manager.email && !manager.name) {
    const employeeRef = resolveUserRef(
      {
        email: body.employeeEmail !== undefined ? body.employeeEmail : request.employeeEmail,
        name: body.employeeName !== undefined ? body.employeeName : request.employeeName,
      },
      userDirectory
    );
    manager = resolveReportingManagerRef(employeeRef, userDirectory) || manager;
  }
  request.managerName = manager.name || '';
  request.managerUserId = manager.userId || '';
  request.managerEmail = manager.email || '';
  const managerExplicitlyUpdated = (
    body.managerUserId !== undefined
    || body.managerEmail !== undefined
    || body.managerName !== undefined
  );

  const assignee = resolveUserRef(
    {
      userId: body.assigneeUserId !== undefined ? body.assigneeUserId : request.assigneeUserId,
      email: body.assigneeEmail !== undefined ? body.assigneeEmail : request.assigneeEmail,
      name: body.assignee !== undefined ? body.assignee : request.assignee,
    },
    userDirectory
  );
  if (isRequestorAssigneeRef(assignee)) {
    request.assignee = String(request.requestedByName || '').trim();
    request.assigneeUserId = String(request.requestedById || '').trim();
    request.assigneeEmail = String(request.requestedByEmail || '').trim().toLowerCase();
  } else {
    request.assignee = assignee.name || '';
    request.assigneeUserId = assignee.userId || '';
    request.assigneeEmail = assignee.email || '';
  }

  if (body.applications !== undefined) {
    request.applications = await normalizeRequestedApplications(body.applications || []);
  }

  if (Array.isArray(body.checklist)) {
    request.checklist = await hydrateChecklistUsers(sanitizeChecklist(body.checklist), userDirectory);
    request.checklist = applyRequestorChecklistOwners(request.checklist, requestorRef);
  }

  if (body.applications !== undefined && request.workflowType === 'application_access') {
    request.checklist = await syncRequestedApplicationTasks(request.checklist || [], request.applications, userDirectory);
  } else if (body.applications !== undefined && request.workflowType === 'offboarding') {
    request.checklist = await syncRequestedApplicationTasks(
      request.checklist || [],
      request.applications,
      userDirectory,
      OFFBOARDING_APP_TASK_OPTIONS
    );
  }
  request.checklist = applyManagerApprovalStepOwners(request.checklist || [], manager, {
    overwrite: managerExplicitlyUpdated,
  });

  return request;
}

async function listWorkflowOptions() {
  const requestTypes = await listRequestTypeDefinitions();
  return requestTypes
    .filter(definition => definition.isActive)
    .map(definition => ({
      workflowType: definition.workflowType,
      workflowLabel: definition.workflowLabel,
      className: definition.className,
      sourceSystem: definition.sourceSystem || 'portal',
      sourceWorkflowSourceId: definition.sourceWorkflowSourceId || '',
      sourceWorkflowKey: definition.sourceWorkflowKey || definition.workflowType,
      autoAddDepartmentApps: !!definition.autoAddDepartmentApps,
      defaultAssignee: definition.defaultAssignee || '',
      defaultAssigneeUserId: definition.defaultAssigneeUserId || '',
      defaultAssigneeEmail: definition.defaultAssigneeEmail || '',
      slaPolicy: normalizeSlaPolicyInput(definition.slaPolicy || {}, DEFAULT_SLA_POLICY),
      formFields: normalizeRequestTypeFormFields(definition.formFields || []),
      customFormFields: normalizeCustomFormFields(definition.customFormFields || []),
    }));
}

module.exports = {
  ALL_DEPARTMENT_LABEL,
  BUILTIN_WORKFLOW_META,
  REQUEST_TYPE_CLASSNAMES,
  applySupportRequestUpdates,
  buildChecklistForCreate,
  createRequestTypeDefinition,
  createSupportRequest,
  deleteRequestTypeDefinition,
  formatRequestTypeDefinition,
  formatWorkflowTypeLabel,
  getRequestTypeDefinition,
  listRequestTypeDefinitions,
  listWorkflowOptions,
  loadUserDirectory,
  resolveUserRef,
  sanitizeChecklist,
  syncCompletedOnboardingUser,
  syncCompletedOffboardingUser,
  ensureCompletedOnboardingProvisioningReady,
  softwareDefaultOwner,
  softwareOwnerCandidates,
  updateRequestTypeDefinition,
};
