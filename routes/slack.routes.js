const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { AppConnector, IntegrationSettings, Software, SupportRequest, User } = require('../db');
const { JWT_SECRET } = require('../config');
const { apiPost } = require('../utils/http');
const { createSupportRequest, listWorkflowOptions } = require('../services/support-request.service');
const { notifySupportRequestChanges } = require('../services/support-notification.service');
const { postSupportRequestCreatedMessage, postSupportRequestUpdateMessage } = require('../services/support-slack-thread.service');

const router = express.Router();
const REQUESTOR_PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const requestorProfileCache = new Map();

const FORM_BLOCKS = {
  workflowType: { blockId: 'workflow_type', actionId: 'workflow_type_action' },
  priority: { blockId: 'priority', actionId: 'priority_action' },
  employeeName: { blockId: 'employee_name', actionId: 'employee_name_action' },
  employeeEmail: { blockId: 'employee_email', actionId: 'employee_email_action' },
  department: { blockId: 'department', actionId: 'department_action' },
  applications: { blockId: 'applications', actionId: 'applications_action' },
  jobTitle: { blockId: 'job_title', actionId: 'job_title_action' },
  location: { blockId: 'location', actionId: 'location_action' },
  managerName: { blockId: 'manager_name', actionId: 'manager_name_action' },
  startDate: { blockId: 'start_date', actionId: 'start_date_action' },
  endDate: { blockId: 'end_date', actionId: 'end_date_action' },
  notes: { blockId: 'notes', actionId: 'notes_action' },
};
const COMMENT_MODAL = {
  callbackId: 'support_request_add_comment_submit',
  blockId: 'comment_input_block',
  actionId: 'comment_input_action',
};

function safeCompare(a, b) {
  const aBuf = Buffer.from(String(a || ''), 'utf8');
  const bBuf = Buffer.from(String(b || ''), 'utf8');
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

async function verifySlackRequest(req) {
  const settings = await IntegrationSettings.findOne({ provider: 'slack' }).lean();
  if (!settings?.signingSecret) {
    throw Object.assign(new Error('Slack signing secret is not configured.'), { status: 503 });
  }

  const signature = req.get('x-slack-signature') || '';
  const timestamp = req.get('x-slack-request-timestamp') || '';
  const rawBody = req.rawBody || '';

  if (!signature || !timestamp || !rawBody) {
    throw Object.assign(new Error('Missing Slack signature headers.'), { status: 401 });
  }

  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 60 * 5) {
    throw Object.assign(new Error('Slack request timestamp is too old.'), { status: 401 });
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const expected = `v0=${crypto.createHmac('sha256', settings.signingSecret).update(baseString).digest('hex')}`;
  if (!safeCompare(expected, signature)) {
    throw Object.assign(new Error('Slack request signature verification failed.'), { status: 401 });
  }
}

async function getSlackBotToken() {
  const connector = await AppConnector.findOne({ appName: 'slack' }).lean();
  if (!connector?.apiToken) {
    throw Object.assign(new Error('Slack Bot Token is not configured. Save the Slack connector bot token under SCIM -> App Connectors first.'), { status: 503 });
  }
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

function workflowTypeNeedsTargetEmployee(workflowType = '') {
  const normalized = String(workflowType || '').trim().toLowerCase();
  return normalized === 'onboarding' || normalized === 'offboarding';
}

function definitionNeedsTargetEmployee(definition = null) {
  return workflowTypeNeedsTargetEmployee(definition?.workflowType || '');
}

async function resolveSlackRequestorProfile(payloadUser = {}) {
  const userId = String(payloadUser?.id || '').trim();
  const fallbackName = String(
    payloadUser?.name
      || payloadUser?.username
      || payloadUser?.id
      || 'Slack User'
  ).trim();
  const fallback = { name: fallbackName, email: '' };
  if (!userId) return fallback;

  const cached = requestorProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { name: cached.name || fallbackName, email: cached.email || '' };
  }

  try {
    const data = await callSlackApi('/api/users.info', { user: userId });
    const profile = data?.user?.profile || {};
    const resolved = {
      name: String(
        profile?.real_name_normalized
        || data?.user?.real_name
        || fallbackName
      ).trim() || fallbackName,
      email: String(profile?.email || '').trim().toLowerCase(),
    };
    requestorProfileCache.set(userId, {
      ...resolved,
      expiresAt: Date.now() + REQUESTOR_PROFILE_CACHE_TTL_MS,
    });
    return resolved;
  } catch {
    requestorProfileCache.set(userId, {
      ...fallback,
      expiresAt: Date.now() + REQUESTOR_PROFILE_CACHE_TTL_MS,
    });
    return fallback;
  }
}

function workflowOptions(options = []) {
  return options.map(option => ({
    text: {
      type: 'plain_text',
      text: option.workflowLabel,
      emoji: true,
    },
    value: option.workflowType,
  }));
}

function softwareOptions(options = []) {
  return options.map(option => ({
    text: {
      type: 'plain_text',
      text: option.name,
      emoji: true,
    },
    value: option.csvId,
  }));
}

function departmentOptions(options = []) {
  return options.map(option => ({
    text: {
      type: 'plain_text',
      text: option,
      emoji: true,
    },
    value: option,
  }));
}

function truncateLabel(value, max = 75) {
  const text = String(value || '').trim();
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function managerOptions(users = []) {
  const sorted = [...users].sort((a, b) => {
    const aPriority = ['admin', 'manager'].includes(String(a?.role || '').trim().toLowerCase()) ? 0 : 1;
    const bPriority = ['admin', 'manager'].includes(String(b?.role || '').trim().toLowerCase()) ? 0 : 1;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return String(a?.name || '').localeCompare(String(b?.name || ''));
  });
  return sorted.map(user => ({
    text: {
      type: 'plain_text',
      text: truncateLabel(user.dept ? `${user.name} · ${user.dept}` : user.name),
      emoji: true,
    },
    value: user.id,
  }));
}

function priorityOptions() {
  return ['low', 'medium', 'high'].map(priority => ({
    text: {
      type: 'plain_text',
      text: priority.charAt(0).toUpperCase() + priority.slice(1),
      emoji: true,
    },
    value: priority,
  }));
}

function findInitialOption(options, value, fallbackIndex = 0) {
  return options.find(option => option.value === value) || options[fallbackIndex];
}

function findInitialOptions(options, values = []) {
  const selected = new Set((Array.isArray(values) ? values : []).map(item => String(item || '').trim()));
  return options.filter(option => selected.has(String(option.value || '').trim()));
}

function getStateValue(values, field) {
  const mapping = FORM_BLOCKS[field];
  const input = values?.[mapping.blockId]?.[mapping.actionId];
  if (!input) return '';
  if (typeof input.value === 'string') return input.value;
  if (typeof input.selected_date === 'string') return input.selected_date;
  if (input.selected_option?.value) return input.selected_option.value;
  return '';
}

function getStateMultiValues(values, field) {
  const mapping = FORM_BLOCKS[field];
  const input = values?.[mapping.blockId]?.[mapping.actionId];
  if (!input?.selected_options) return [];
  return input.selected_options
    .map(option => option?.value)
    .filter(Boolean);
}

function fieldConfigMap(definition = null) {
  const map = new Map((definition?.formFields || []).map(field => [field.key, field]));
  return map;
}

function fieldEnabled(definition, key, defaultEnabled = true) {
  const field = fieldConfigMap(definition).get(key);
  return field ? !!field.enabled : defaultEnabled;
}

function fieldRequired(definition, key, defaultRequired = false) {
  const field = fieldConfigMap(definition).get(key);
  return field ? !!field.required : defaultRequired;
}

function fieldLabel(definition, key, fallback) {
  const field = fieldConfigMap(definition).get(key);
  return String(field?.label || fallback || '').trim();
}

function definitionByWorkflowType(definitions = [], workflowType = '') {
  return definitions.find(definition => definition.workflowType === workflowType) || null;
}

function workflowDefinitionsSignature(definitions = []) {
  const normalized = (definitions || [])
    .map(definition => ({
      workflowType: String(definition.workflowType || ''),
      workflowLabel: String(definition.workflowLabel || ''),
      formFields: (definition.formFields || [])
        .map(field => ({
          key: String(field.key || ''),
          label: String(field.label || ''),
          enabled: !!field.enabled,
          required: !!field.required,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    }))
    .sort((a, b) => a.workflowType.localeCompare(b.workflowType));

  return crypto
    .createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

async function listActiveSoftwareOptions() {
  const apps = await Software.find({ status: 'Active' })
    .sort({ name: 1 })
    .select('csvId name')
    .lean();

  return apps
    .filter(app => app?.csvId && app?.name)
    .map(app => ({ csvId: String(app.csvId), name: String(app.name) }))
    .slice(0, 100);
}

async function listSlackFormUsers() {
  const users = await User.find({ status: 'Active' })
    .sort({ first: 1, last: 1 })
    .select('first last email dept role status')
    .lean();

  return users
    .map(user => {
      const id = user?._id?.toString?.() || '';
      const name = `${String(user?.first || '').trim()} ${String(user?.last || '').trim()}`.trim();
      const email = String(user?.email || '').trim().toLowerCase();
      const dept = String(user?.dept || '').trim();
      const role = String(user?.role || '').trim();
      const status = String(user?.status || '').trim();
      return { id, name, email, dept, role, status };
    })
    .filter(user => user.id && user.name);
}

function managerById(users = [], userId = '') {
  const id = String(userId || '').trim();
  if (!id) return null;
  return users.find(user => user.id === id) || null;
}

async function listSlackFormReferenceData() {
  const [appOptions, users] = await Promise.all([
    listActiveSoftwareOptions(),
    listSlackFormUsers(),
  ]);

  const departments = [...new Set(users.map(user => user.dept).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 100);

  return {
    appOptions,
    users: users.slice(0, 100),
    departments,
  };
}

function buildSupportRequestModal(definitions = [], referenceData = {}, selectedWorkflowType = '', privateMetadata = {}, stateValues = {}) {
  const appOptions = referenceData.appOptions || [];
  const managerUsers = referenceData.users || [];
  const departmentValues = referenceData.departments || [];
  const workflowSelectOptions = workflowOptions(definitions);
  const prioritySelectOptions = priorityOptions();
  const applicationSelectOptions = softwareOptions(appOptions);
  const departmentSelectOptions = departmentOptions(departmentValues);
  const managerSelectOptions = managerOptions(managerUsers);
  const fallbackWorkflowType = definitions[0]?.workflowType || '';
  const resolvedWorkflowType = selectedWorkflowType || fallbackWorkflowType;
  const definition = definitionByWorkflowType(definitions, resolvedWorkflowType);
  const needsTargetEmployee = definitionNeedsTargetEmployee(definition);
  const selectedPriority = getStateValue(stateValues, 'priority') || 'medium';
  const selectedDepartment = getStateValue(stateValues, 'department');
  const selectedManagerUserId = getStateValue(stateValues, 'managerName');
  const selectedApps = getStateMultiValues(stateValues, 'applications');
  const blocks = [];
  if (privateMetadata.schemaRefreshed) {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: ':information_source: Form updated with latest Support Center settings. Please review and submit.',
        },
      ],
    });
  }

  blocks.push({
    type: 'input',
    block_id: FORM_BLOCKS.workflowType.blockId,
    dispatch_action: true,
    label: { type: 'plain_text', text: 'Type of request', emoji: true },
    element: {
      type: 'static_select',
      action_id: FORM_BLOCKS.workflowType.actionId,
      options: workflowSelectOptions,
      initial_option: findInitialOption(workflowSelectOptions, resolvedWorkflowType),
    },
  });

  if (fieldEnabled(definition, 'priority', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'priority', true),
      block_id: FORM_BLOCKS.priority.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'priority', 'Priority'), emoji: true },
      element: {
        type: 'static_select',
        action_id: FORM_BLOCKS.priority.actionId,
        options: prioritySelectOptions,
        initial_option: findInitialOption(prioritySelectOptions, selectedPriority, 1),
      },
    });
  }

  const showEmployeeNameField = (
    fieldEnabled(definition, 'employeeName', true)
    && needsTargetEmployee
  );
  if (showEmployeeNameField) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'employeeName', true),
      block_id: FORM_BLOCKS.employeeName.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'employeeName', 'Employee name'), emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: FORM_BLOCKS.employeeName.actionId,
        initial_value: getStateValue(stateValues, 'employeeName') || '',
        placeholder: { type: 'plain_text', text: 'Jane Doe' },
      },
    });
  }

  const showEmployeeEmailField = (
    fieldEnabled(definition, 'employeeEmail', true)
    && needsTargetEmployee
  );
  if (showEmployeeEmailField) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'employeeEmail', true),
      block_id: FORM_BLOCKS.employeeEmail.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'employeeEmail', 'Employee email'), emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: FORM_BLOCKS.employeeEmail.actionId,
        initial_value: getStateValue(stateValues, 'employeeEmail') || '',
        placeholder: { type: 'plain_text', text: 'jane@company.com' },
      },
    });
  }

  if (fieldEnabled(definition, 'department', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'department', true),
      block_id: FORM_BLOCKS.department.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'department', 'Department'), emoji: true },
      element: {
        type: 'static_select',
        action_id: FORM_BLOCKS.department.actionId,
        placeholder: { type: 'plain_text', text: 'Select department' },
        options: departmentSelectOptions,
        initial_option: findInitialOption(departmentSelectOptions, selectedDepartment),
      },
    });
  }

  if (fieldEnabled(definition, 'applications', false)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'applications', false),
      block_id: FORM_BLOCKS.applications.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'applications', 'Applications'), emoji: true },
      element: {
        type: 'multi_static_select',
        action_id: FORM_BLOCKS.applications.actionId,
        options: applicationSelectOptions,
        initial_options: findInitialOptions(applicationSelectOptions, selectedApps),
      },
    });
  }

  if (fieldEnabled(definition, 'jobTitle', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'jobTitle', false),
      block_id: FORM_BLOCKS.jobTitle.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'jobTitle', 'Job title'), emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: FORM_BLOCKS.jobTitle.actionId,
        initial_value: getStateValue(stateValues, 'jobTitle'),
        placeholder: { type: 'plain_text', text: 'Software Engineer' },
      },
    });
  }

  if (fieldEnabled(definition, 'location', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'location', false),
      block_id: FORM_BLOCKS.location.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'location', 'Location'), emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: FORM_BLOCKS.location.actionId,
        initial_value: getStateValue(stateValues, 'location'),
        placeholder: { type: 'plain_text', text: 'USA' },
      },
    });
  }

  if (fieldEnabled(definition, 'managerName', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'managerName', false),
      block_id: FORM_BLOCKS.managerName.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'managerName', 'Manager'), emoji: true },
      element: {
        type: 'static_select',
        action_id: FORM_BLOCKS.managerName.actionId,
        placeholder: { type: 'plain_text', text: 'Select manager' },
        options: managerSelectOptions,
        initial_option: findInitialOption(managerSelectOptions, selectedManagerUserId),
      },
    });
  }

  if (fieldEnabled(definition, 'startDate', true)) {
    const startDate = getStateValue(stateValues, 'startDate');
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'startDate', false),
      block_id: FORM_BLOCKS.startDate.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'startDate', 'Start date'), emoji: true },
      element: {
        type: 'datepicker',
        action_id: FORM_BLOCKS.startDate.actionId,
        ...(startDate ? { initial_date: startDate } : {}),
        placeholder: { type: 'plain_text', text: 'Select a date' },
      },
    });
  }

  if (fieldEnabled(definition, 'endDate', true)) {
    const endDate = getStateValue(stateValues, 'endDate');
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'endDate', false),
      block_id: FORM_BLOCKS.endDate.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'endDate', 'End date'), emoji: true },
      element: {
        type: 'datepicker',
        action_id: FORM_BLOCKS.endDate.actionId,
        ...(endDate ? { initial_date: endDate } : {}),
        placeholder: { type: 'plain_text', text: 'Select a date' },
      },
    });
  }

  if (fieldEnabled(definition, 'notes', true)) {
    blocks.push({
      type: 'input',
      optional: !fieldRequired(definition, 'notes', false),
      block_id: FORM_BLOCKS.notes.blockId,
      label: { type: 'plain_text', text: fieldLabel(definition, 'notes', 'Notes'), emoji: true },
      element: {
        type: 'plain_text_input',
        action_id: FORM_BLOCKS.notes.actionId,
        initial_value: getStateValue(stateValues, 'notes'),
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Anything the IT team should know' },
      },
    });
  }

  return {
    type: 'modal',
    callback_id: 'support_request_create',
    title: {
      type: 'plain_text',
      text: 'Create Support Request',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Create',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    private_metadata: JSON.stringify({
      source: 'slack_command',
      channelId: String(privateMetadata.channelId || '').trim(),
      teamId: String(privateMetadata.teamId || '').trim(),
      commandUserId: String(privateMetadata.commandUserId || '').trim(),
      requestorName: String(privateMetadata.requestorName || '').trim(),
      requestorEmail: String(privateMetadata.requestorEmail || '').trim().toLowerCase(),
      schemaFingerprint: String(privateMetadata.schemaFingerprint || '').trim(),
      schemaRefreshed: !!privateMetadata.schemaRefreshed,
    }),
    blocks,
  };
}

function resolveInitialWorkflowType(text = '', options = []) {
  const trimmed = String(text || '').trim().toLowerCase();
  if (!trimmed) return options[0]?.workflowType || '';

  const exactType = options.find(option => option.workflowType === trimmed);
  if (exactType) return exactType.workflowType;

  const labelMatch = options.find(option => option.workflowLabel.toLowerCase() === trimmed);
  if (labelMatch) return labelMatch.workflowType;

  const partialLabelMatch = options.find(option => option.workflowLabel.toLowerCase().includes(trimmed));
  return partialLabelMatch?.workflowType || options[0]?.workflowType || '';
}

function validationErrors(payload, definition = null) {
  const errors = {};
  const needsTargetEmployee = definitionNeedsTargetEmployee(definition);
  if (!payload.workflowType) errors[FORM_BLOCKS.workflowType.blockId] = 'Select a request type.';
  if (needsTargetEmployee && fieldEnabled(definition, 'employeeName', true) && fieldRequired(definition, 'employeeName', true) && !payload.employeeName) {
    errors[FORM_BLOCKS.employeeName.blockId] = 'Employee name is required.';
  }
  if (needsTargetEmployee && fieldEnabled(definition, 'employeeEmail', true) && fieldRequired(definition, 'employeeEmail', true) && !payload.employeeEmail) {
    errors[FORM_BLOCKS.employeeEmail.blockId] = 'Employee email is required.';
  }
  if (needsTargetEmployee && fieldEnabled(definition, 'employeeEmail', true) && payload.employeeEmail && !/^\S+@\S+\.\S+$/.test(payload.employeeEmail)) {
    errors[FORM_BLOCKS.employeeEmail.blockId] = 'Enter a valid email address.';
  }
  if (fieldEnabled(definition, 'department', true) && fieldRequired(definition, 'department', true) && !payload.department) {
    errors[FORM_BLOCKS.department.blockId] = 'Department is required.';
  }
  if (fieldEnabled(definition, 'applications', false) && fieldRequired(definition, 'applications', false) && !payload.applications.length) {
    errors[FORM_BLOCKS.applications.blockId] = 'Select at least one application.';
  }
  if (fieldEnabled(definition, 'managerName', true) && fieldRequired(definition, 'managerName', false) && !payload.managerUserId) {
    errors[FORM_BLOCKS.managerName.blockId] = 'Select a manager.';
  }
  return errors;
}

function parseInteractionPayload(req) {
  const raw = req.body?.payload;
  if (!raw) throw Object.assign(new Error('Missing Slack interaction payload.'), { status: 400 });
  return JSON.parse(raw);
}

function parsePrivateMetadata(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function persistSlackThreadContext(request, slackPost = {}) {
  if (!request || !slackPost?.posted) return;
  if (!request.slackChannelId && slackPost.channelId) request.slackChannelId = slackPost.channelId;
  if (!request.slackMessageTs && slackPost.messageTs) request.slackMessageTs = slackPost.messageTs;
  if (!request.slackThreadTs && slackPost.threadTs) request.slackThreadTs = slackPost.threadTs;
  if (request.isModified()) await request.save();
}

function actorFromSlackPayload(payload = {}) {
  return payload.user?.username || payload.user?.name || payload.user?.id || 'Slack User';
}

function compactText(value, max = 200) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function allChecklistStepsDone(checklist = []) {
  const steps = Array.isArray(checklist) ? checklist : [];
  return steps.length > 0 && steps.every(step => step.status === 'done');
}

async function handleTaskCompleteAction(payload = {}, action = {}) {
  const token = String(action.value || '').trim();
  if (!token) return { ok: false, message: 'Invalid task action. Missing token.' };

  let data = null;
  try {
    data = jwt.verify(token, JWT_SECRET);
  } catch {
    return { ok: false, message: 'This task action link is invalid or expired.' };
  }

  if (data.kind !== 'support_task_complete') {
    return { ok: false, message: 'This action is not valid for support task completion.' };
  }

  const request = await SupportRequest.findById(data.requestId);
  if (!request) return { ok: false, message: 'Support request not found for this task action.' };

  const previousRequest = request.toObject();
  const stepKey = String(data.requestItemKey || '').trim();
  const step = (request.checklist || []).find(item => item.key === stepKey);
  if (!step) return { ok: false, message: 'Workflow step not found.' };
  if (step.approvalMode === 'manager') return { ok: false, message: 'This step requires manager approval and cannot be completed from Slack.' };
  if (step.status === 'done') return { ok: true, message: `Step "${step.label}" is already marked as done.` };

  step.status = 'done';
  step.completedAt = new Date();
  step.notes = `${step.notes ? `${step.notes}\n` : ''}Completed from Slack by ${actorFromSlackPayload(payload)} on ${new Date().toLocaleString('en-IN')}`.trim();

  const currentStatus = String(request.status || '').toLowerCase();
  if (currentStatus === 'open') {
    request.status = 'in_progress';
  }
  if (!['cancelled'].includes(currentStatus) && allChecklistStepsDone(request.checklist || [])) {
    request.status = 'completed';
  }

  await request.save();
  await notifySupportRequestChanges(previousRequest, request);
  if (request.isModified()) await request.save();
  const slackPost = await postSupportRequestUpdateMessage(previousRequest, request, {
    source: 'slack_dm',
    actor: actorFromSlackPayload(payload),
    forceRefresh: true,
    eventText: `✅ ${actorFromSlackPayload(payload)} marked "${step.label}" complete`,
  });
  await persistSlackThreadContext(request, slackPost);

  return { ok: true, message: `Step "${step.label}" marked as done for request ${request.requestId}.` };
}

function modalStateValue(values = {}, blockId = '', actionId = '') {
  const input = values?.[blockId]?.[actionId];
  if (!input) return '';
  if (typeof input.value === 'string') return input.value;
  return '';
}

function buildCommentModal(commentToken = '') {
  return {
    type: 'modal',
    callback_id: COMMENT_MODAL.callbackId,
    title: {
      type: 'plain_text',
      text: 'Add Comment',
      emoji: true,
    },
    submit: {
      type: 'plain_text',
      text: 'Save',
      emoji: true,
    },
    close: {
      type: 'plain_text',
      text: 'Cancel',
      emoji: true,
    },
    private_metadata: JSON.stringify({ commentToken: String(commentToken || '').trim() }),
    blocks: [
      {
        type: 'input',
        block_id: COMMENT_MODAL.blockId,
        label: { type: 'plain_text', text: 'Comment', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: COMMENT_MODAL.actionId,
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Add an update for this request...' },
        },
      },
    ],
  };
}

async function handleAddCommentAction(payload = {}, action = {}) {
  const token = String(action.value || '').trim();
  if (!token) return { ok: false, message: 'Invalid comment action. Missing token.' };

  let data = null;
  try {
    data = jwt.verify(token, JWT_SECRET);
  } catch {
    return { ok: false, message: 'This comment action link is invalid or expired.' };
  }
  if (data.kind !== 'support_request_add_comment') {
    return { ok: false, message: 'This action is not valid for comments.' };
  }

  await callSlackApi('/api/views.open', {
    trigger_id: payload.trigger_id,
    view: buildCommentModal(token),
  });

  return { ok: true, message: '' };
}

async function handleCommentModalSubmission(payload = {}) {
  const privateMetadata = parsePrivateMetadata(payload.view?.private_metadata);
  const commentToken = String(privateMetadata.commentToken || '').trim();
  if (!commentToken) return { ok: false, fieldError: 'Invalid comment token.' };

  let data = null;
  try {
    data = jwt.verify(commentToken, JWT_SECRET);
  } catch {
    return { ok: false, fieldError: 'This comment link is invalid or expired.' };
  }
  if (data.kind !== 'support_request_add_comment') {
    return { ok: false, fieldError: 'This comment action is no longer valid.' };
  }

  const values = payload.view?.state?.values || {};
  const comment = modalStateValue(values, COMMENT_MODAL.blockId, COMMENT_MODAL.actionId).trim();
  if (!comment) return { ok: false, fieldError: 'Comment is required.' };

  const request = await SupportRequest.findById(data.requestId);
  if (!request) return { ok: false, fieldError: 'Support request not found.' };

  const previousRequest = request.toObject();
  const actor = actorFromSlackPayload(payload);
  const stamp = new Date().toLocaleString('en-IN');
  const commentEntry = `[Slack comment by ${actor} on ${stamp}]\n${comment}`;
  request.notes = `${request.notes ? `${request.notes}\n\n` : ''}${commentEntry}`.trim();
  if (String(request.status || '').toLowerCase() === 'open') request.status = 'in_progress';

  await request.save();
  await notifySupportRequestChanges(previousRequest, request);
  if (request.isModified()) await request.save();
  const slackPost = await postSupportRequestUpdateMessage(previousRequest, request, {
    source: 'slack_comment',
    actor,
    forceRefresh: true,
    eventText: `💬 ${actor}: ${compactText(comment, 160)}`,
  });
  await persistSlackThreadContext(request, slackPost);

  return { ok: true };
}

router.post(
  '/support-command',
  express.urlencoded({
    extended: false,
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
  async (req, res) => {
    try {
      await verifySlackRequest(req);
      // Ack immediately so Slack never times out this slash command.
      // Modal open is done asynchronously and still uses the same trigger_id.
      res.status(200).send('');
      void (async () => {
        try {
          const options = await listWorkflowOptions();
          const referenceData = await listSlackFormReferenceData();
          const initialWorkflowType = resolveInitialWorkflowType(req.body?.text || '', options);
          const schemaFingerprint = workflowDefinitionsSignature(options);
          const privateMetadata = {
            channelId: req.body?.channel_id || '',
            teamId: req.body?.team_id || '',
            commandUserId: req.body?.user_id || '',
            requestorName: req.body?.user_name || 'Slack User',
            requestorEmail: '',
            schemaFingerprint,
            schemaRefreshed: false,
          };
          await callSlackApi('/api/views.open', {
            trigger_id: req.body?.trigger_id,
            view: buildSupportRequestModal(options, referenceData, initialWorkflowType, privateMetadata),
          });
        } catch (backgroundError) {
          console.error('[slack support-command] modal open failed:', backgroundError.message);
        }
      })();
      return;
    } catch (e) {
      console.error('[slack support-command] request rejected:', e.message);
      res.status(200).json({
        response_type: 'ephemeral',
        text: e.message || 'Slack support request form could not be opened.',
      });
    }
  }
);

router.post(
  '/interactivity',
  express.urlencoded({
    extended: false,
    limit: '1mb',
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
  async (req, res) => {
    try {
      await verifySlackRequest(req);
      const payload = parseInteractionPayload(req);

      if (payload.type === 'block_actions') {
        const taskCompleteAction = (payload.actions || []).find(action => action.action_id === 'support_task_complete');
        if (taskCompleteAction) {
          const result = await handleTaskCompleteAction(payload, taskCompleteAction);
          return res.status(200).json({
            response_type: 'ephemeral',
            replace_original: false,
            text: result.ok ? `Done: ${result.message}` : `Error: ${result.message}`,
          });
        }

        const addCommentAction = (payload.actions || []).find(action => action.action_id === 'support_request_add_comment');
        if (addCommentAction) {
          const result = await handleAddCommentAction(payload, addCommentAction);
          if (!result.ok) {
            return res.status(200).json({
              response_type: 'ephemeral',
              replace_original: false,
              text: `Error: ${result.message}`,
            });
          }
          return res.status(200).send('');
        }
      }

      if (payload.type === 'view_submission' && payload.view?.callback_id === COMMENT_MODAL.callbackId) {
        const result = await handleCommentModalSubmission(payload);
        if (!result.ok) {
          return res.status(200).json({
            response_action: 'errors',
            errors: {
              [COMMENT_MODAL.blockId]: result.fieldError || 'Failed to save comment.',
            },
          });
        }
        return res.status(200).send('');
      }

      const options = await listWorkflowOptions();
      const referenceData = await listSlackFormReferenceData();
      const latestSchemaFingerprint = workflowDefinitionsSignature(options);

      if (payload.type === 'block_actions' && payload.view?.callback_id === 'support_request_create') {
        const workflowAction = (payload.actions || []).find(action => action.action_id === FORM_BLOCKS.workflowType.actionId);
        if (workflowAction) {
          const values = payload.view?.state?.values || {};
          const privateMetadata = parsePrivateMetadata(payload.view?.private_metadata);
          const selectedWorkflowType = workflowAction.selected_option?.value
            || getStateValue(values, 'workflowType')
            || options[0]?.workflowType
            || '';

          await callSlackApi('/api/views.update', {
            view_id: payload.view.id,
            hash: payload.view.hash,
            view: buildSupportRequestModal(options, referenceData, selectedWorkflowType, {
              ...privateMetadata,
              schemaFingerprint: latestSchemaFingerprint,
              schemaRefreshed: false,
            }, values),
          });
        }
        return res.status(200).send('');
      }

      if (payload.type !== 'view_submission' || payload.view?.callback_id !== 'support_request_create') {
        return res.status(200).send('');
      }

      const values = payload.view?.state?.values || {};
      const privateMetadata = parsePrivateMetadata(payload.view?.private_metadata);
      const selectedWorkflowType = getStateValue(values, 'workflowType') || options[0]?.workflowType || '';
      if (String(privateMetadata.schemaFingerprint || '') !== latestSchemaFingerprint) {
        return res.status(200).json({
          response_action: 'update',
          view: buildSupportRequestModal(options, referenceData, selectedWorkflowType, {
            ...privateMetadata,
            schemaFingerprint: latestSchemaFingerprint,
            schemaRefreshed: true,
          }, values),
        });
      }

      const workflowDefinition = definitionByWorkflowType(options, getStateValue(values, 'workflowType'));
      const needsTargetEmployee = definitionNeedsTargetEmployee(workflowDefinition);
      let requestorName = String(privateMetadata.requestorName || '').trim();
      let requestorEmail = String(privateMetadata.requestorEmail || '').trim().toLowerCase();
      if (!requestorName || !requestorEmail) {
        const requestorProfile = await resolveSlackRequestorProfile(payload.user || {});
        if (!requestorName) requestorName = requestorProfile.name || '';
        if (!requestorEmail) requestorEmail = requestorProfile.email || '';
      }
      const managerUserId = getStateValue(values, 'managerName').trim();
      const manager = managerById(referenceData.users || [], managerUserId);
      const supportPayload = {
        workflowType: getStateValue(values, 'workflowType'),
        priority: fieldEnabled(workflowDefinition, 'priority', true)
          ? (getStateValue(values, 'priority') || 'medium')
          : 'medium',
        employeeName: fieldEnabled(workflowDefinition, 'employeeName', true)
          ? (needsTargetEmployee ? getStateValue(values, 'employeeName').trim() : (requestorName || getStateValue(values, 'employeeName').trim()))
          : '',
        employeeEmail: fieldEnabled(workflowDefinition, 'employeeEmail', true)
          ? (needsTargetEmployee ? getStateValue(values, 'employeeEmail').trim() : (requestorEmail || getStateValue(values, 'employeeEmail').trim()))
          : '',
        department: fieldEnabled(workflowDefinition, 'department', true)
          ? getStateValue(values, 'department').trim()
          : '',
        applications: fieldEnabled(workflowDefinition, 'applications', false)
          ? getStateMultiValues(values, 'applications')
          : [],
        jobTitle: fieldEnabled(workflowDefinition, 'jobTitle', true)
          ? getStateValue(values, 'jobTitle').trim()
          : '',
        location: fieldEnabled(workflowDefinition, 'location', true)
          ? getStateValue(values, 'location').trim()
          : '',
        managerName: fieldEnabled(workflowDefinition, 'managerName', true) ? (manager?.name || '') : '',
        managerUserId: fieldEnabled(workflowDefinition, 'managerName', true) ? (manager?.id || '') : '',
        managerEmail: fieldEnabled(workflowDefinition, 'managerName', true) ? (manager?.email || '') : '',
        startDate: fieldEnabled(workflowDefinition, 'startDate', true)
          ? getStateValue(values, 'startDate').trim()
          : '',
        endDate: fieldEnabled(workflowDefinition, 'endDate', true)
          ? getStateValue(values, 'endDate').trim()
          : '',
        notes: fieldEnabled(workflowDefinition, 'notes', true)
          ? getStateValue(values, 'notes').trim()
          : '',
      };

      const errors = validationErrors(supportPayload, workflowDefinition);
      if (Object.keys(errors).length) {
        return res.status(200).json({
          response_action: 'errors',
          errors,
        });
      }

      const supportRequest = await createSupportRequest(supportPayload, {
        id: payload.user?.id || '',
        name: requestorName || payload.user?.username || payload.user?.name || 'Slack User',
        email: requestorEmail || '',
      }, {
        requestedVia: 'slack_command',
        slackContext: {
          channelId: privateMetadata.channelId || '',
          teamId: privateMetadata.teamId || payload.team?.id || '',
          commandUserId: privateMetadata.commandUserId || payload.user?.id || '',
        },
      });
      res.status(200).send('');

      void (async () => {
        try {
          await notifySupportRequestChanges(null, supportRequest);
          const slackPost = await postSupportRequestCreatedMessage(supportRequest);
          if (slackPost.posted) {
            supportRequest.slackChannelId = slackPost.channelId || supportRequest.slackChannelId;
            supportRequest.slackMessageTs = slackPost.messageTs || supportRequest.slackMessageTs;
            supportRequest.slackThreadTs = slackPost.threadTs || supportRequest.slackThreadTs;
          }
          if (supportRequest.isModified()) await supportRequest.save();
        } catch (backgroundError) {
          console.error('[slack interactivity] post-submit processing failed:', backgroundError.message);
        }
      })();

      return;
    } catch (e) {
      return res.status(200).json({
        response_action: 'errors',
        errors: {
          [FORM_BLOCKS.workflowType.blockId]: e.message || 'Slack support request failed.',
        },
      });
    }
  }
);

module.exports = router;
