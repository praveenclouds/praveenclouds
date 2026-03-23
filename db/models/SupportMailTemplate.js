const mongoose = require('mongoose');

const DEFAULT_SUPPORT_MAIL_TEMPLATES = [
  {
    key: 'request_assignee',
    label: 'Request Assignee',
    audience: 'Request assignee',
    description: 'Sent when a support request is created or reassigned to the primary assignee.',
    tokens: ['requestId', 'workflowLabel', 'employeeName', 'employeeEmail', 'department', 'priority', 'requestedByName', 'applications', 'detailUrl'],
    subjectTemplate: 'New support request assigned — {{requestId}}',
    introTemplate: 'A support request has been assigned to you.',
    bodyTemplate: 'Request Type: {{workflowLabel}}\nEmployee: {{employeeName}} ({{employeeEmail}})\nDepartment: {{department}}\nPriority: {{priority}}\nRequested by: {{requestedByName}}\nApplications: {{applications}}',
    ctaLabel: 'Open Support Center',
    secondaryCtaLabel: '',
    footerNote: 'Use the Support Center link above to review the checklist and start the work.',
    sortOrder: 10,
    isSystem: true,
  },
  {
    key: 'task_assignment',
    label: 'Task Assignment',
    audience: 'Task owner / software admins',
    description: 'Sent when a workflow step is assigned, including software access tasks routed to app admins.',
    tokens: ['requestId', 'workflowLabel', 'employeeName', 'employeeEmail', 'department', 'priority', 'requestedByName', 'applications', 'stepLabel', 'detailUrl'],
    subjectTemplate: 'Task assigned — {{stepLabel}} for {{employeeName}}',
    introTemplate: 'A workflow task has been assigned to you.',
    bodyTemplate: 'Request ID: {{requestId}}\nRequest Type: {{workflowLabel}}\nEmployee: {{employeeName}} ({{employeeEmail}})\nDepartment: {{department}}\nPriority: {{priority}}\nTask: {{stepLabel}}\nApplications: {{applications}}',
    ctaLabel: 'Open Support Center',
    secondaryCtaLabel: '',
    footerNote: 'Update the step in Support Center after the work is complete.',
    sortOrder: 20,
    isSystem: true,
  },
  {
    key: 'manager_approval',
    label: 'Manager Approval',
    audience: 'Reporting manager',
    description: 'Sent when a workflow step needs manager approval before the request can continue.',
    tokens: ['requestId', 'workflowLabel', 'employeeName', 'employeeEmail', 'department', 'priority', 'requestedByName', 'applications', 'stepLabel', 'approveUrl', 'rejectUrl'],
    subjectTemplate: 'Approval needed — {{stepLabel}} for {{employeeName}}',
    introTemplate: 'Your approval is required before this support request can continue.',
    bodyTemplate: 'Request ID: {{requestId}}\nRequest Type: {{workflowLabel}}\nEmployee: {{employeeName}} ({{employeeEmail}})\nDepartment: {{department}}\nPriority: {{priority}}\nRequested by: {{requestedByName}}\nApproval Task: {{stepLabel}}\nApplications: {{applications}}',
    ctaLabel: 'Approve',
    secondaryCtaLabel: 'Reject',
    footerNote: 'These approval links expire in 48 hours.',
    sortOrder: 30,
    isSystem: true,
  },
];

const supportMailTemplateSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, trim: true },
    label: { type: String, required: true, trim: true },
    audience: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    tokens: { type: [String], default: [] },
    subjectTemplate: { type: String, required: true, trim: true },
    introTemplate: { type: String, default: '', trim: true },
    bodyTemplate: { type: String, default: '', trim: true },
    ctaLabel: { type: String, default: '', trim: true },
    secondaryCtaLabel: { type: String, default: '', trim: true },
    footerNote: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
    isSystem: { type: Boolean, default: true },
  },
  { timestamps: true }
);

supportMailTemplateSchema.index({ sortOrder: 1, key: 1 });

const SupportMailTemplate = mongoose.model('SupportMailTemplate', supportMailTemplateSchema);

module.exports = SupportMailTemplate;
module.exports.DEFAULT_SUPPORT_MAIL_TEMPLATES = DEFAULT_SUPPORT_MAIL_TEMPLATES;
