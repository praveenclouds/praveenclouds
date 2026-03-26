const { writeLog } = require('./log.service');

const REQUEST_FIELDS = [
  ['status', 'Status'],
  ['priority', 'Priority'],
  ['assignee', 'Assignee'],
  ['assigneeEmail', 'Assignee Email'],
  ['managerName', 'Manager'],
  ['managerEmail', 'Manager Email'],
  ['department', 'Department'],
  ['jobTitle', 'Job Title'],
  ['location', 'Location'],
  ['startDate', 'Start Date'],
  ['endDate', 'End Date'],
  ['notes', 'Notes'],
];

function asObject(doc = {}) {
  return doc?.toObject ? doc.toObject() : { ...(doc || {}) };
}

function asString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function summarizeNotes(value, max = 120) {
  const normalized = asString(value).replace(/\s+/g, ' ');
  if (!normalized) return '';
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function requestLabel(request = {}) {
  const requestId = asString(request.requestId) || 'Support Request';
  const workflow = asString(request.workflowLabel || request.workflowType);
  return workflow ? `${requestId} (${workflow})` : requestId;
}

function requestEntityId(request = {}) {
  return request?._id?.toString?.() || asString(request.id);
}

function checklistMap(checklist = []) {
  const map = new Map();
  for (const step of Array.isArray(checklist) ? checklist : []) {
    const key = asString(step?.key);
    if (!key) continue;
    map.set(key, step);
  }
  return map;
}

function requestChanges(previousRequest = {}, currentRequest = {}) {
  const changes = [];
  for (const [field, label] of REQUEST_FIELDS) {
    const prevValue = field === 'notes'
      ? summarizeNotes(previousRequest[field])
      : asString(previousRequest[field]);
    const nextValue = field === 'notes'
      ? summarizeNotes(currentRequest[field])
      : asString(currentRequest[field]);
    if (prevValue === nextValue) continue;
    changes.push({
      field: label,
      oldValue: prevValue || '—',
      newValue: nextValue || '—',
    });
  }
  return changes;
}

function checklistEvents(previousRequest = {}, currentRequest = {}) {
  const events = [];
  const previousByKey = checklistMap(previousRequest.checklist || []);
  const currentSteps = Array.isArray(currentRequest.checklist) ? currentRequest.checklist : [];

  for (const step of currentSteps) {
    const key = asString(step?.key);
    if (!key) continue;
    const previousStep = previousByKey.get(key);
    if (!previousStep) continue;
    const stepLabel = asString(step?.label) || key;

    const prevStatus = asString(previousStep.status || 'pending');
    const nextStatus = asString(step.status || 'pending');
    if (prevStatus !== nextStatus) {
      events.push({
        eventType: 'support_task_status_changed',
        summary: `${requestLabel(currentRequest)} • Task "${stepLabel}" status changed (${prevStatus || 'pending'} → ${nextStatus || 'pending'})`,
        remarks: `Task key: ${key}`,
        changes: [
          { field: 'Task', oldValue: stepLabel, newValue: stepLabel },
          { field: 'Status', oldValue: prevStatus || 'pending', newValue: nextStatus || 'pending' },
        ],
      });
    }

    const prevOwner = asString(previousStep.owner);
    const nextOwner = asString(step.owner);
    const prevOwnerEmail = asString(previousStep.ownerEmail);
    const nextOwnerEmail = asString(step.ownerEmail);
    if (prevOwner !== nextOwner || prevOwnerEmail !== nextOwnerEmail) {
      events.push({
        eventType: 'support_task_assignment_changed',
        summary: `${requestLabel(currentRequest)} • Task "${stepLabel}" owner changed (${prevOwner || 'Unassigned'} → ${nextOwner || 'Unassigned'})`,
        remarks: `Task key: ${key}`,
        changes: [
          { field: 'Task', oldValue: stepLabel, newValue: stepLabel },
          { field: 'Owner', oldValue: prevOwner || 'Unassigned', newValue: nextOwner || 'Unassigned' },
          { field: 'Owner Email', oldValue: prevOwnerEmail || '—', newValue: nextOwnerEmail || '—' },
        ],
      });
    }

    const prevApproval = asString(previousStep.approvalStatus || 'not_requested');
    const nextApproval = asString(step.approvalStatus || 'not_requested');
    if (prevApproval !== nextApproval) {
      events.push({
        eventType: 'support_approval_status_changed',
        summary: `${requestLabel(currentRequest)} • Task "${stepLabel}" approval changed (${prevApproval} → ${nextApproval})`,
        remarks: `Task key: ${key}`,
        changes: [
          { field: 'Task', oldValue: stepLabel, newValue: stepLabel },
          { field: 'Approval', oldValue: prevApproval, newValue: nextApproval },
        ],
      });
    }
  }

  return events;
}

async function writeSupportLog({
  eventType,
  request,
  summary,
  actorName = '',
  changes = [],
  remarks = '',
}) {
  const entityId = requestEntityId(request);
  if (!entityId) return;
  await writeLog({
    eventType,
    entityType: 'support_request',
    entityId,
    entityLabel: requestLabel(request),
    summary,
    changes,
    remarks: remarks || '',
    actorName: asString(actorName) || undefined,
  });
}

async function logSupportRequestCreated(request, actorName = '', source = 'portal') {
  await writeSupportLog({
    eventType: 'support_request_created',
    request,
    actorName,
    remarks: `source=${source}`,
    summary: `${requestLabel(request)} created via ${source}`,
    changes: [
      { field: 'Status', oldValue: '—', newValue: asString(request.status || 'open') },
      { field: 'Priority', oldValue: '—', newValue: asString(request.priority || 'medium') },
      { field: 'Assignee', oldValue: '—', newValue: asString(request.assignee || 'Unassigned') },
    ],
  });
}

async function logSupportRequestDeleted(request, actorName = '', source = 'portal') {
  await writeSupportLog({
    eventType: 'support_request_deleted',
    request,
    actorName,
    remarks: `source=${source}`,
    summary: `${requestLabel(request)} deleted`,
  });
}

async function logSupportCommentAdded(request, actorName = '', commentText = '', source = 'support_center') {
  const compactComment = summarizeNotes(commentText, 180);
  await writeSupportLog({
    eventType: 'support_comment_added',
    request,
    actorName,
    remarks: `source=${source}`,
    summary: `${requestLabel(request)} comment added${compactComment ? `: ${compactComment}` : ''}`,
  });
}

async function logSupportRequestApprovalAction({
  request,
  step = {},
  decision = '',
  actorName = '',
  source = 'approval_link',
}) {
  const stepLabel = asString(step.label) || asString(step.key) || 'Manager approval step';
  const normalizedDecision = asString(decision || 'updated').toLowerCase();
  await writeSupportLog({
    eventType: 'support_request_approval_action',
    request,
    actorName,
    remarks: `source=${source}; task=${asString(step.key)}`,
    summary: `${requestLabel(request)} manager ${normalizedDecision} "${stepLabel}"`,
    changes: [
      { field: 'Task', oldValue: stepLabel, newValue: stepLabel },
      { field: 'Decision', oldValue: 'pending', newValue: normalizedDecision || 'updated' },
      { field: 'Approval', oldValue: 'pending', newValue: asString(step.approvalStatus || '') || '—' },
    ],
  });
}

async function logSupportRequestUpdated(previousRequest, currentRequest, actorName = '', source = 'support_center') {
  const previous = asObject(previousRequest);
  const current = asObject(currentRequest);

  const requestLevelChanges = requestChanges(previous, current);
  if (requestLevelChanges.length) {
    await writeSupportLog({
      eventType: 'support_request_updated',
      request: current,
      actorName,
      remarks: `source=${source}`,
      summary: `${requestLabel(current)} updated (${requestLevelChanges.length} field${requestLevelChanges.length > 1 ? 's' : ''})`,
      changes: requestLevelChanges,
    });
  }

  const stepEvents = checklistEvents(previous, current);
  for (const event of stepEvents) {
    await writeSupportLog({
      eventType: event.eventType,
      request: current,
      actorName,
      remarks: [event.remarks, `source=${source}`].filter(Boolean).join('; '),
      summary: event.summary,
      changes: event.changes || [],
    });
  }
}

module.exports = {
  logSupportCommentAdded,
  logSupportRequestApprovalAction,
  logSupportRequestCreated,
  logSupportRequestDeleted,
  logSupportRequestUpdated,
};
