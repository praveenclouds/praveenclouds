const mongoose = require('mongoose');

const REQUEST_TYPE_CLASSNAMES = [
  'application-access',
  'new-app',
  'new-hardware',
  'app-hardware-issue',
  'onboarding',
  'offboarding',
];

const REQUEST_FORM_FIELD_DEFINITIONS = [
  { key: 'priority', label: 'Priority', required: true, enabledByDefault: true },
  { key: 'employeeName', label: 'Employee Name', required: true, enabledByDefault: true },
  { key: 'employeeEmail', label: 'Employee Email', required: true, enabledByDefault: true },
  { key: 'department', label: 'Department', required: true, enabledByDefault: true },
  { key: 'applications', label: 'Applications', required: false, enabledByDefault: false },
  { key: 'jobTitle', label: 'Job Title', required: false, enabledByDefault: true },
  { key: 'location', label: 'Location', required: false, enabledByDefault: true },
  { key: 'managerName', label: 'Manager', required: false, enabledByDefault: true },
  { key: 'startDate', label: 'Start Date', required: false, enabledByDefault: true },
  { key: 'endDate', label: 'End Date', required: false, enabledByDefault: true },
  { key: 'notes', label: 'Notes', required: false, enabledByDefault: true },
];

function buildDefaultFormFields(overrides = {}) {
  return REQUEST_FORM_FIELD_DEFINITIONS.map(field => ({
    key: field.key,
    label: field.label,
    enabled: Object.prototype.hasOwnProperty.call(overrides[field.key] || {}, 'enabled')
      ? !!overrides[field.key].enabled
      : field.enabledByDefault !== false,
    required: Object.prototype.hasOwnProperty.call(overrides[field.key] || {}, 'required')
      ? !!overrides[field.key].required
      : !!field.required,
  }));
}

const requestTypeFormFieldSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    required: { type: Boolean, default: false },
  },
  { _id: false }
);

const requestTypeStepSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    area: { type: String, default: '', trim: true },
    dependsOn: { type: String, default: '', trim: true },
    defaultOwner: { type: String, default: '', trim: true },
    defaultOwnerUserId: { type: String, default: '', trim: true },
    defaultOwnerEmail: { type: String, default: '', trim: true, lowercase: true },
    approvalMode: { type: String, enum: ['none', 'manager'], default: 'none' },
  },
  { _id: false }
);

const DEFAULT_REQUEST_TYPE_DEFINITIONS = [
  {
    workflowType: 'application_access',
    workflowLabel: 'Application Access Request',
    className: 'application-access',
    sortOrder: 10,
    defaultAssignee: '',
    autoAddDepartmentApps: false,
    formFields: buildDefaultFormFields({
      applications: { enabled: true, required: true },
    }),
    checklist: [
      { key: 'access_review', label: 'Requested apps and permissions reviewed', area: 'Applications' },
      { key: 'approval_recorded', label: 'Manager or application owner approval recorded', area: 'Approvals', approvalMode: 'manager' },
      { key: 'account_provisioned', label: 'User account or entitlement provisioned', area: 'Identity' },
      { key: 'mfa_verified', label: 'MFA and security checks completed', area: 'Security' },
      { key: 'validation_complete', label: 'Requester validated application access', area: 'Requester' },
    ],
  },
  {
    workflowType: 'new_app',
    workflowLabel: 'New App Request',
    className: 'new-app',
    sortOrder: 20,
    defaultAssignee: '',
    autoAddDepartmentApps: false,
    formFields: buildDefaultFormFields(),
    checklist: [
      { key: 'business_case', label: 'Business need and app details captured', area: 'Intake' },
      { key: 'security_review', label: 'Security and compliance review completed', area: 'Security' },
      { key: 'licensing_review', label: 'Licensing and budget impact reviewed', area: 'Procurement' },
      { key: 'technical_review', label: 'Technical compatibility confirmed', area: 'IT Operations' },
      { key: 'decision_shared', label: 'Approval or rejection shared with requester', area: 'Communication' },
    ],
  },
  {
    workflowType: 'new_hardware',
    workflowLabel: 'New Hardware Request',
    className: 'new-hardware',
    sortOrder: 30,
    defaultAssignee: '',
    autoAddDepartmentApps: false,
    formFields: buildDefaultFormFields(),
    checklist: [
      { key: 'hardware_spec', label: 'Hardware specification confirmed', area: 'Intake' },
      { key: 'manager_approval', label: 'Manager approval recorded', area: 'Approvals', approvalMode: 'manager' },
      { key: 'inventory_check', label: 'Inventory checked for available stock', area: 'IT Assets' },
      { key: 'purchase_or_assign', label: 'Hardware purchased or assigned', area: 'Procurement' },
      { key: 'delivery_complete', label: 'Device handoff or delivery completed', area: 'Fulfillment' },
    ],
  },
  {
    workflowType: 'app_hardware_issue',
    workflowLabel: 'Application and Hardware Issue',
    className: 'app-hardware-issue',
    sortOrder: 40,
    defaultAssignee: '',
    autoAddDepartmentApps: false,
    formFields: buildDefaultFormFields(),
    checklist: [
      { key: 'issue_logged', label: 'Issue details captured and categorized', area: 'Service Desk' },
      { key: 'triage_started', label: 'Initial troubleshooting started', area: 'Support' },
      { key: 'root_cause', label: 'Root cause identified or escalation assigned', area: 'Operations' },
      { key: 'resolution_applied', label: 'Fix applied and validated', area: 'Resolution' },
      { key: 'requester_confirmed', label: 'Requester confirmed resolution', area: 'Closure' },
    ],
  },
  {
    workflowType: 'onboarding',
    workflowLabel: 'Employee Onboarding',
    className: 'onboarding',
    sortOrder: 50,
    defaultAssignee: '',
    autoAddDepartmentApps: true,
    formFields: buildDefaultFormFields(),
    checklist: [
      { key: 'employee_record', label: 'Employee profile created', area: 'HRIS' },
      { key: 'workspace_account', label: 'Google workspace account provisioned', area: 'Identity', dependsOn: 'employee_record' },
      { key: 'asset_ready', label: 'Laptop and accessories prepared', area: 'IT Assets' },
      { key: 'orientation', label: 'Orientation and day-one support scheduled', area: 'Enablement' },
    ],
  },
  {
    workflowType: 'offboarding',
    workflowLabel: 'Employee Offboarding',
    className: 'offboarding',
    sortOrder: 60,
    defaultAssignee: '',
    autoAddDepartmentApps: false,
    formFields: buildDefaultFormFields(),
    checklist: [
      { key: 'manager_confirmation', label: 'Manager offboarding confirmation received', area: 'People Ops', approvalMode: 'manager' },
      { key: 'account_disable', label: 'SSO and workspace account disabled', area: 'Identity' },
      { key: 'app_revoke', label: 'Software access revoked', area: 'Applications' },
      { key: 'asset_return', label: 'Assigned assets collected', area: 'IT Assets' },
      { key: 'ownership_transfer', label: 'Ownership and shared resources transferred', area: 'Knowledge Transfer' },
      { key: 'closure_note', label: 'Exit checklist documented and closed', area: 'Closure' },
    ],
  },
];

function normalizeWorkflowType(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

const supportRequestTypeSchema = new mongoose.Schema(
  {
    workflowType: { type: String, required: true, unique: true, trim: true },
    workflowLabel: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    className: { type: String, enum: REQUEST_TYPE_CLASSNAMES, default: 'new-app' },
    sourceSystem: { type: String, default: 'portal', trim: true },
    sourceWorkflowSourceId: { type: String, default: '', trim: true },
    sourceWorkflowKey: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
    defaultAssignee: { type: String, default: '', trim: true },
    defaultAssigneeUserId: { type: String, default: '', trim: true },
    defaultAssigneeEmail: { type: String, default: '', trim: true, lowercase: true },
    autoAddDepartmentApps: { type: Boolean, default: false },
    isSystem: { type: Boolean, default: false },
    formFields: { type: [requestTypeFormFieldSchema], default: () => buildDefaultFormFields() },
    checklist: { type: [requestTypeStepSchema], default: [] },
  },
  { timestamps: true }
);

supportRequestTypeSchema.pre('validate', function () {
  this.workflowType = normalizeWorkflowType(this.workflowType);
  if (!this.sourceWorkflowKey) this.sourceWorkflowKey = this.workflowType;
});

supportRequestTypeSchema.index({ isActive: 1, sortOrder: 1 });

const SupportRequestType = mongoose.model('SupportRequestType', supportRequestTypeSchema);

module.exports = SupportRequestType;
module.exports.REQUEST_TYPE_CLASSNAMES = REQUEST_TYPE_CLASSNAMES;
module.exports.DEFAULT_REQUEST_TYPE_DEFINITIONS = DEFAULT_REQUEST_TYPE_DEFINITIONS;
module.exports.REQUEST_FORM_FIELD_DEFINITIONS = REQUEST_FORM_FIELD_DEFINITIONS;
module.exports.normalizeWorkflowType = normalizeWorkflowType;
