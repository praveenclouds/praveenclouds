const crypto = require('crypto');
const express = require('express');
const { AppConnector, IntegrationSettings } = require('../db');
const { apiPost } = require('../utils/http');
const { createSupportRequest, listWorkflowOptions } = require('../services/support-request.service');

const router = express.Router();

const FORM_BLOCKS = {
  workflowType: { blockId: 'workflow_type', actionId: 'workflow_type_action' },
  priority: { blockId: 'priority', actionId: 'priority_action' },
  employeeName: { blockId: 'employee_name', actionId: 'employee_name_action' },
  employeeEmail: { blockId: 'employee_email', actionId: 'employee_email_action' },
  department: { blockId: 'department', actionId: 'department_action' },
  jobTitle: { blockId: 'job_title', actionId: 'job_title_action' },
  location: { blockId: 'location', actionId: 'location_action' },
  managerName: { blockId: 'manager_name', actionId: 'manager_name_action' },
  startDate: { blockId: 'start_date', actionId: 'start_date_action' },
  endDate: { blockId: 'end_date', actionId: 'end_date_action' },
  notes: { blockId: 'notes', actionId: 'notes_action' },
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

function getStateValue(values, field) {
  const mapping = FORM_BLOCKS[field];
  const input = values?.[mapping.blockId]?.[mapping.actionId];
  if (!input) return '';
  if (typeof input.value === 'string') return input.value;
  if (typeof input.selected_date === 'string') return input.selected_date;
  if (input.selected_option?.value) return input.selected_option.value;
  return '';
}

function buildSupportRequestModal(definitions = [], selectedWorkflowType = '') {
  const workflowSelectOptions = workflowOptions(definitions);
  const prioritySelectOptions = priorityOptions();
  const fallbackWorkflowType = definitions[0]?.workflowType || '';

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
    private_metadata: JSON.stringify({ source: 'slack_command' }),
    blocks: [
      {
        type: 'input',
        block_id: FORM_BLOCKS.workflowType.blockId,
        label: { type: 'plain_text', text: 'Type of request', emoji: true },
        element: {
          type: 'static_select',
          action_id: FORM_BLOCKS.workflowType.actionId,
          options: workflowSelectOptions,
          initial_option: findInitialOption(workflowSelectOptions, selectedWorkflowType || fallbackWorkflowType),
        },
      },
      {
        type: 'input',
        block_id: FORM_BLOCKS.priority.blockId,
        label: { type: 'plain_text', text: 'Priority', emoji: true },
        element: {
          type: 'static_select',
          action_id: FORM_BLOCKS.priority.actionId,
          options: prioritySelectOptions,
          initial_option: findInitialOption(prioritySelectOptions, 'medium', 1),
        },
      },
      {
        type: 'input',
        block_id: FORM_BLOCKS.employeeName.blockId,
        label: { type: 'plain_text', text: 'Employee name', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.employeeName.actionId,
          placeholder: { type: 'plain_text', text: 'Jane Doe' },
        },
      },
      {
        type: 'input',
        block_id: FORM_BLOCKS.employeeEmail.blockId,
        label: { type: 'plain_text', text: 'Employee email', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.employeeEmail.actionId,
          placeholder: { type: 'plain_text', text: 'jane@company.com' },
        },
      },
      {
        type: 'input',
        block_id: FORM_BLOCKS.department.blockId,
        label: { type: 'plain_text', text: 'Department', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.department.actionId,
          placeholder: { type: 'plain_text', text: 'Engineering' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.jobTitle.blockId,
        label: { type: 'plain_text', text: 'Job title', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.jobTitle.actionId,
          placeholder: { type: 'plain_text', text: 'Software Engineer' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.location.blockId,
        label: { type: 'plain_text', text: 'Location', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.location.actionId,
          placeholder: { type: 'plain_text', text: 'Chennai' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.managerName.blockId,
        label: { type: 'plain_text', text: 'Manager', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.managerName.actionId,
          placeholder: { type: 'plain_text', text: 'Manager name' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.startDate.blockId,
        label: { type: 'plain_text', text: 'Start date', emoji: true },
        element: {
          type: 'datepicker',
          action_id: FORM_BLOCKS.startDate.actionId,
          placeholder: { type: 'plain_text', text: 'Select a date' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.endDate.blockId,
        label: { type: 'plain_text', text: 'End date', emoji: true },
        element: {
          type: 'datepicker',
          action_id: FORM_BLOCKS.endDate.actionId,
          placeholder: { type: 'plain_text', text: 'Select a date' },
        },
      },
      {
        type: 'input',
        optional: true,
        block_id: FORM_BLOCKS.notes.blockId,
        label: { type: 'plain_text', text: 'Notes', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: FORM_BLOCKS.notes.actionId,
          multiline: true,
          placeholder: { type: 'plain_text', text: 'Anything the IT team should know' },
        },
      },
    ],
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

function validationErrors(payload) {
  const errors = {};
  if (!payload.workflowType) errors[FORM_BLOCKS.workflowType.blockId] = 'Select a request type.';
  if (!payload.employeeName) errors[FORM_BLOCKS.employeeName.blockId] = 'Employee name is required.';
  if (!payload.employeeEmail) errors[FORM_BLOCKS.employeeEmail.blockId] = 'Employee email is required.';
  if (payload.employeeEmail && !/^\S+@\S+\.\S+$/.test(payload.employeeEmail)) {
    errors[FORM_BLOCKS.employeeEmail.blockId] = 'Enter a valid email address.';
  }
  if (!payload.department) errors[FORM_BLOCKS.department.blockId] = 'Department is required.';
  return errors;
}

function parseInteractionPayload(req) {
  const raw = req.body?.payload;
  if (!raw) throw Object.assign(new Error('Missing Slack interaction payload.'), { status: 400 });
  return JSON.parse(raw);
}

router.post(
  '/support-command',
  express.urlencoded({
    extended: false,
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
  async (req, res) => {
    try {
      await verifySlackRequest(req);

      const options = await listWorkflowOptions();
      const initialWorkflowType = resolveInitialWorkflowType(req.body?.text || '', options);
      await callSlackApi('/api/views.open', {
        trigger_id: req.body?.trigger_id,
        view: buildSupportRequestModal(options, initialWorkflowType),
      });

      res.status(200).send('');
    } catch (e) {
      res.status(e.status || 400).json({
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
    verify: (req, res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  }),
  async (req, res) => {
    try {
      await verifySlackRequest(req);
      const payload = parseInteractionPayload(req);

      if (payload.type !== 'view_submission' || payload.view?.callback_id !== 'support_request_create') {
        return res.status(200).send('');
      }

      const values = payload.view?.state?.values || {};
      const supportPayload = {
        workflowType: getStateValue(values, 'workflowType'),
        priority: getStateValue(values, 'priority') || 'medium',
        employeeName: getStateValue(values, 'employeeName').trim(),
        employeeEmail: getStateValue(values, 'employeeEmail').trim(),
        department: getStateValue(values, 'department').trim(),
        jobTitle: getStateValue(values, 'jobTitle').trim(),
        location: getStateValue(values, 'location').trim(),
        managerName: getStateValue(values, 'managerName').trim(),
        startDate: getStateValue(values, 'startDate').trim(),
        endDate: getStateValue(values, 'endDate').trim(),
        notes: getStateValue(values, 'notes').trim(),
      };

      const errors = validationErrors(supportPayload);
      if (Object.keys(errors).length) {
        return res.status(200).json({
          response_action: 'errors',
          errors,
        });
      }

      await createSupportRequest(supportPayload, {
        id: payload.user?.id || '',
        name: payload.user?.username || payload.user?.name || 'Slack User',
        email: '',
      }, {
        requestedVia: 'slack_command',
      });

      return res.status(200).send('');
    } catch (e) {
      return res.status(e.status || 400).json({
        response_action: 'errors',
        errors: {
          [FORM_BLOCKS.employeeName.blockId]: e.message || 'Slack support request failed.',
        },
      });
    }
  }
);

module.exports = router;
