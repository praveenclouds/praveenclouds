const { SupportRequest, SupportRequestType, Software, SlackWorkflowImport, User } = require('../db');

const ALL_DEPARTMENT_LABEL = 'All Departments';
const DEFAULT_REQUEST_TYPES = SupportRequestType.DEFAULT_REQUEST_TYPE_DEFINITIONS || [];
const REQUEST_TYPE_CLASSNAMES = SupportRequestType.REQUEST_TYPE_CLASSNAMES || [];
const REQUEST_FORM_FIELD_DEFINITIONS = SupportRequestType.REQUEST_FORM_FIELD_DEFINITIONS || [];
const normalizeWorkflowType = SupportRequestType.normalizeWorkflowType;

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

function looksLikeEmail(value) {
  return /^\S+@\S+\.\S+$/.test(String(value || '').trim());
}

function normalizeUserSummary(user = {}) {
  const name = fullName(user);
  return {
    userId: user._id?.toString?.() || user.id || '',
    name,
    email: String(user.email || '').trim().toLowerCase(),
    department: String(user.dept || '').trim(),
    role: String(user.role || '').trim(),
  };
}

async function loadUserDirectory() {
  const users = await User.find().sort({ first: 1, last: 1 }).lean();
  const byId = new Map();
  const byEmail = new Map();
  const byName = new Map();

  users.forEach(user => {
    const summary = normalizeUserSummary(user);
    if (summary.userId) byId.set(summary.userId, summary);
    if (summary.email) byEmail.set(summary.email, summary);
    if (summary.name) byName.set(summary.name.toLowerCase(), summary);
  });

  return { users: users.map(normalizeUserSummary), byId, byEmail, byName };
}

function resolveUserRef(input = {}, userDirectory = null) {
  const userId = String(input.userId || input.id || '').trim();
  const email = String(input.email || '').trim().toLowerCase();
  const name = String(input.name || input.label || input.value || '').trim();

  if (userDirectory) {
    const matchedUser = (
      (userId && userDirectory.byId.get(userId))
      || (email && userDirectory.byEmail.get(email))
      || (name && userDirectory.byName.get(name.toLowerCase()))
    );
    if (matchedUser) return { ...matchedUser };
  }

  if (!name && email) {
    return { userId: '', name: email, email };
  }

  return {
    userId: userId || '',
    name,
    email,
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

function normalizePortalLocation(value, fallback = 'Remote') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'chennai') return 'Chennai';
  if (normalized === 'coimbatore') return 'Coimbatore';
  if (normalized === 'remote') return 'Remote';
  return fallback;
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
    existingUser.location = normalizePortalLocation(request.location, existingUser.location || 'Remote');
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

function sanitizeChecklist(input = []) {
  return input.map(item => ({
    key: String(item.key || '').trim(),
    label: String(item.label || '').trim(),
    area: String(item.area || '').trim(),
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
    defaultAssignee: source.defaultAssignee || '',
    defaultAssigneeUserId: source.defaultAssigneeUserId || '',
    defaultAssigneeEmail: source.defaultAssigneeEmail || '',
    autoAddDepartmentApps: !!source.autoAddDepartmentApps,
    isSystem: !!source.isSystem,
    formFields: normalizeRequestTypeFormFields(source.formFields || []),
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
    }

    if (nextFormFields.length !== existingFormFields.length) changed = true;
    if (changed) {
      await SupportRequestType.updateOne({ _id: item._id }, { $set: { checklist, formFields: nextFormFields } });
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
    defaultAssignee: people.defaultAssignee,
    defaultAssigneeUserId: people.defaultAssigneeUserId,
    defaultAssigneeEmail: people.defaultAssigneeEmail,
    autoAddDepartmentApps,
    formFields,
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

  if (String(input.workflowLabel || '').trim()) requestType.workflowLabel = String(input.workflowLabel).trim();
  requestType.description = String(input.description || '').trim();
  requestType.className = REQUEST_TYPE_CLASSNAMES.includes(input.className) ? input.className : requestType.className;
  requestType.sortOrder = Number(input.sortOrder || 0);
  requestType.isActive = input.isActive !== false;
  requestType.defaultAssignee = people.defaultAssignee;
  requestType.defaultAssigneeUserId = people.defaultAssigneeUserId;
  requestType.defaultAssigneeEmail = people.defaultAssigneeEmail;
  requestType.autoAddDepartmentApps = !!input.autoAddDepartmentApps;
  requestType.formFields = normalizeRequestTypeFormFields(input.formFields || []).map(field => (
    field.key === 'department' && requestType.autoAddDepartmentApps
      ? { ...field, enabled: true, required: true }
      : field
  ));
  requestType.checklist = people.checklist;

  await requestType.save();
  return formatRequestTypeDefinition(requestType);
}

function buildSlackChecklist(workflow) {
  const steps = Array.isArray(workflow?.steps) ? workflow.steps : [];
  if (!steps.length) {
    return [
      {
        key: 'workflow_review',
        label: `Review imported workflow${workflow?.title ? `: ${workflow.title}` : ''}`,
        area: 'Slack Workflow',
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

async function addRequestedApplicationTasks(checklist = [], applications = [], userDirectory = null) {
  if (!applications.length) return checklist;

  const software = await Software.find({ csvId: { $in: applications.map(app => app.csvId) } })
    .select('csvId name owner admins provisioningMethod connectorType supportsDeprovision provisioningNotes')
    .lean();
  const softwareById = new Map(software.map(item => [item.csvId, item]));
  const existingKeys = new Set(checklist.map(item => item.key));
  const dependencyKey = checklist.find(item => item.key === 'approval_recorded')?.key
    || checklist.find(item => item.key === 'access_review')?.key
    || '';

  const appTasks = applications
    .map(app => {
      const softwareItem = softwareById.get(app.csvId);
      const owner = softwareDefaultOwner(softwareItem, userDirectory);
      return {
        key: `app_access_${String(app.csvId).toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
        label: `${app.name} access granted`,
        area: 'Applications',
        softwareCsvId: app.csvId,
        provisioningMethod: softwareItem?.provisioningMethod || 'Manual',
        connectorType: softwareItem?.connectorType || '',
        supportsDeprovision: !!softwareItem?.supportsDeprovision,
        provisioningNotes: softwareItem?.provisioningNotes || '',
        dependsOn: dependencyKey,
        status: 'pending',
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

async function syncRequestedApplicationTasks(checklist = [], applications = [], userDirectory = null) {
  const preservedSteps = checklist.filter(item => !(item.softwareCsvId && item.key.startsWith('app_access_')));
  const existingAppSteps = new Map(
    checklist
      .filter(item => item.softwareCsvId && item.key.startsWith('app_access_'))
      .map(item => [item.softwareCsvId, item])
  );

  const withRequestedApps = await addRequestedApplicationTasks(preservedSteps, applications, userDirectory);
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

async function createSupportRequest(body = {}, actor = {}, options = {}) {
  const userDirectory = await loadUserDirectory();
  const workflow = await resolveWorkflowDefinition(body.workflowType);
  const applications = await normalizeRequestedApplications(body.applications || []);
  let checklist = await buildChecklistForCreate(body, workflow, userDirectory);
  if (workflow.workflowType === 'application_access') {
    checklist = await addRequestedApplicationTasks(checklist, applications, userDirectory);
  }

  const manager = resolveUserRef(
    {
      userId: body.managerUserId,
      email: body.managerEmail,
      name: body.managerName,
    },
    userDirectory
  );
  const assignee = resolveUserRef(
    {
      userId: body.assigneeUserId || workflow.defaultAssigneeUserId,
      email: body.assigneeEmail || workflow.defaultAssigneeEmail,
      name: body.assignee || workflow.defaultAssignee,
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
    priority: body.priority || 'medium',
    employeeName: body.employeeName,
    employeeEmail: body.employeeEmail,
    department: body.department || '',
    jobTitle: body.jobTitle || '',
    location: body.location || '',
    managerName: manager.name || String(body.managerName || '').trim(),
    managerUserId: manager.userId || '',
    managerEmail: manager.email || String(body.managerEmail || '').trim().toLowerCase(),
    startDate: body.startDate || '',
    endDate: body.endDate || '',
    notes: body.notes || '',
    assignee: assignee.name || String(body.assignee || '').trim(),
    assigneeUserId: assignee.userId || '',
    assigneeEmail: assignee.email || String(body.assigneeEmail || '').trim().toLowerCase(),
    applications,
    requestedById: actor.id || '',
    requestedByName: actor.name || '',
    requestedByEmail: actor.email || '',
    checklist,
  });
}

async function applySupportRequestUpdates(request, body = {}) {
  const userDirectory = await loadUserDirectory();

  const manager = resolveUserRef(
    {
      userId: body.managerUserId !== undefined ? body.managerUserId : request.managerUserId,
      email: body.managerEmail !== undefined ? body.managerEmail : request.managerEmail,
      name: body.managerName !== undefined ? body.managerName : request.managerName,
    },
    userDirectory
  );
  request.managerName = manager.name || '';
  request.managerUserId = manager.userId || '';
  request.managerEmail = manager.email || '';

  const assignee = resolveUserRef(
    {
      userId: body.assigneeUserId !== undefined ? body.assigneeUserId : request.assigneeUserId,
      email: body.assigneeEmail !== undefined ? body.assigneeEmail : request.assigneeEmail,
      name: body.assignee !== undefined ? body.assignee : request.assignee,
    },
    userDirectory
  );
  request.assignee = assignee.name || '';
  request.assigneeUserId = assignee.userId || '';
  request.assigneeEmail = assignee.email || '';

  if (body.applications !== undefined) {
    request.applications = await normalizeRequestedApplications(body.applications || []);
  }

  if (Array.isArray(body.checklist)) {
    request.checklist = await hydrateChecklistUsers(sanitizeChecklist(body.checklist), userDirectory);
  }

  if (body.applications !== undefined && request.workflowType === 'application_access') {
    request.checklist = await syncRequestedApplicationTasks(request.checklist || [], request.applications, userDirectory);
  }

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
      formFields: normalizeRequestTypeFormFields(definition.formFields || []),
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
  formatRequestTypeDefinition,
  formatWorkflowTypeLabel,
  getRequestTypeDefinition,
  listRequestTypeDefinitions,
  listWorkflowOptions,
  loadUserDirectory,
  resolveUserRef,
  sanitizeChecklist,
  syncCompletedOnboardingUser,
  ensureCompletedOnboardingProvisioningReady,
  softwareDefaultOwner,
  softwareOwnerCandidates,
  updateRequestTypeDefinition,
};
