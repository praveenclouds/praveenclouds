/**
 * services/scim.service.js — SCIM 2.0 helpers
 *
 * Contains:
 *   DEPT_MAP          — canonical department name mapping
 *   mapDept()         — normalises raw dept string
 *   userToSCIM()      — converts a User document to a SCIM 2.0 User resource
 *   parseSCIMFilter() — parses a SCIM filter query string to a Mongoose query
 *   scimBodyToUser()  — converts a SCIM POST/PUT body to User model fields
 *   requireSCIM()     — Express middleware: validates SCIM Bearer token
 */
const bcrypt      = require('bcryptjs');
const { SCIMConfig } = require('../db');

// ── Department name normalisation map ─────────────────────────────────────────
const DEPT_MAP = {
  engineering:        'Engineering',
  'ai-service':       'AI-Service',
  'ai service':       'AI-Service',
  qa:                 'QA',
  it:                 'IT',
  hr:                 'HR',
  product:            'Product',
  'customer support': 'Customer Support',
  accounts:           'Accounts',
  'data science':     'Data Science',
  sales:              'Sales',
  marketing:          'Marketing',
  legal:              'Legal',
  executive:          'Executive',
  operations:         'Operations',
  finance:            'Finance',
  other:              'Other',
};

function mapDept(raw) {
  if (!raw) return 'Other';
  return DEPT_MAP[(raw || '').toLowerCase()] || 'Other';
}

// ── Serialise a User document to SCIM 2.0 format ──────────────────────────────
function userToSCIM(u) {
  return {
    schemas: [
      'urn:ietf:params:scim:schemas:core:2.0:User',
      'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
    ],
    id:          u._id.toString(),
    externalId:  u.scimExternalId || '',
    userName:    u.email,
    name: {
      formatted:  `${u.first} ${u.last}`.trim(),
      givenName:  u.first,
      familyName: u.last,
    },
    displayName: `${u.first} ${u.last}`.trim(),
    title:       u.jobTitle || '',
    active:      u.status === 'Active',
    emails: [{ value: u.email, primary: true, type: 'work' }],
    'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User': {
      department: u.dept || '',
    },
    meta: {
      resourceType: 'User',
      location:     `/scim/v2/Users/${u._id}`,
      created:      u.createdAt,
      lastModified: u.updatedAt,
    },
  };
}

// ── Parse a SCIM filter string into a Mongoose query object ───────────────────
function parseSCIMFilter(filter) {
  if (!filter) return {};
  const m = filter.match(/^(\w+)\s+eq\s+"?([^"]+)"?$/i);
  if (!m) return {};
  const [, attr, val] = m;
  if (attr === 'userName')   return { email: val.toLowerCase() };
  if (attr === 'externalId') return { scimExternalId: val };
  if (attr === 'active')     return { status: val === 'true' ? 'Active' : 'Inactive' };
  return {};
}

// ── Map a SCIM request body to User model fields ──────────────────────────────
function scimBodyToUser(body) {
  const enterprise = body['urn:ietf:params:scim:schemas:extension:enterprise:2.0:User'] || {};
  return {
    email:          (body.userName || '').toLowerCase().trim(),
    first:          (body.name && body.name.givenName)  || (body.displayName || '').split(' ')[0] || 'Unknown',
    last:           (body.name && body.name.familyName) || (body.displayName || '').split(' ').slice(1).join(' ') || '',
    status:         body.active === false ? 'Inactive' : 'Active',
    jobTitle:       body.title || '',
    dept:           mapDept(enterprise.department || body.department),
    scimExternalId: body.externalId || '',
  };
}

// ── SCIM Bearer-token auth middleware ─────────────────────────────────────────
async function requireSCIM(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401', detail: 'Authorization header missing or invalid.',
    });
  }
  const cfg = await SCIMConfig.findOne();
  // Use bcrypt.compare so the stored hash is never compared in plain text.
  const tokenValid = cfg && cfg.bearerToken && await bcrypt.compare(token, cfg.bearerToken);
  if (!cfg || !cfg.enabled || !tokenValid) {
    return res.status(401).json({
      schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
      status: '401', detail: 'Invalid or inactive SCIM bearer token.',
    });
  }
  next();
}

module.exports = { DEPT_MAP, mapDept, userToSCIM, parseSCIMFilter, scimBodyToUser, requireSCIM };
