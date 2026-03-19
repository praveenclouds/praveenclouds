/**
 * routes/scim.routes.js — SCIM 2.0 Server
 *
 * GET    /scim/v2/ServiceProviderConfig
 * GET    /scim/v2/ResourceTypes
 * GET    /scim/v2/Schemas
 * GET    /scim/v2/Users
 * POST   /scim/v2/Users
 * GET    /scim/v2/Users/:id
 * PUT    /scim/v2/Users/:id
 * PATCH  /scim/v2/Users/:id
 * DELETE /scim/v2/Users/:id
 *
 * All routes require SCIM Bearer-token auth via requireSCIM.
 * Content-Type is forced to application/scim+json by the parent app.use().
 */
const router = require('express').Router();
const { User } = require('../db');
const { requireSCIM, userToSCIM, parseSCIMFilter, scimBodyToUser } = require('../services/scim.service');

// ── GET /scim/v2/ServiceProviderConfig ────────────────────────────────────────
router.get('/ServiceProviderConfig', requireSCIM, (req, res) => {
  res.json({
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
    documentationUri: '',
    patch:  { supported: true },
    bulk:   { supported: false, maxOperations: 0, maxPayloadSize: 0 },
    filter: { supported: true, maxResults: 200 },
    changePassword: { supported: false },
    sort: { supported: false },
    etag: { supported: false },
    authenticationSchemes: [{
      type: 'oauthbearertoken', name: 'OAuth Bearer Token',
      description: 'Authentication scheme using Bearer token', primary: true,
    }],
    meta: { resourceType: 'ServiceProviderConfig', location: '/scim/v2/ServiceProviderConfig' },
  });
});

// ── GET /scim/v2/ResourceTypes ────────────────────────────────────────────────
router.get('/ResourceTypes', requireSCIM, (req, res) => {
  res.json({
    schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 1, startIndex: 1, itemsPerPage: 1,
    Resources: [{
      schemas:     ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'],
      id: 'User', name: 'User', endpoint: '/Users',
      description: 'User accounts',
      schema: 'urn:ietf:params:scim:schemas:core:2.0:User',
      schemaExtensions: [{
        schema: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
        required: false,
      }],
      meta: { resourceType: 'ResourceType', location: '/scim/v2/ResourceTypes/User' },
    }],
  });
});

// ── GET /scim/v2/Schemas ──────────────────────────────────────────────────────
router.get('/Schemas', requireSCIM, (req, res) => {
  res.json({
    schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
    totalResults: 1, startIndex: 1, itemsPerPage: 1,
    Resources: [{
      id: 'urn:ietf:params:scim:schemas:core:2.0:User',
      name: 'User', description: 'User Account',
      attributes: [
        { name: 'userName',    type: 'string',  required: true,  uniqueness: 'global' },
        { name: 'displayName', type: 'string',  required: false, uniqueness: 'none' },
        { name: 'name', type: 'complex', required: false, subAttributes: [
          { name: 'givenName',  type: 'string' },
          { name: 'familyName', type: 'string' },
          { name: 'formatted',  type: 'string' },
        ]},
        { name: 'title',  type: 'string',  required: false },
        { name: 'active', type: 'boolean', required: false },
        { name: 'emails', type: 'complex', multiValued: true, subAttributes: [
          { name: 'value',   type: 'string' },
          { name: 'primary', type: 'boolean' },
        ]},
      ],
    }],
  });
});

// ── GET /scim/v2/Users ────────────────────────────────────────────────────────
router.get('/Users', requireSCIM, async (req, res) => {
  try {
    const filterQuery = parseSCIMFilter(req.query.filter || '');
    const startIndex  = parseInt(req.query.startIndex || '1', 10);
    const count       = parseInt(req.query.count || '100', 10);
    const skip        = Math.max(startIndex - 1, 0);

    const [users, total] = await Promise.all([
      User.find(filterQuery).skip(skip).limit(count).lean(),
      User.countDocuments(filterQuery),
    ]);

    res.json({
      schemas:      ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: total,
      startIndex,
      itemsPerPage: users.length,
      Resources:    users.map(userToSCIM),
    });
  } catch (e) {
    res.status(500).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '500', detail: e.message });
  }
});

// ── POST /scim/v2/Users ───────────────────────────────────────────────────────
router.post('/Users', requireSCIM, async (req, res) => {
  try {
    const fields = scimBodyToUser(req.body);

    const existing = await User.findOne({ email: fields.email });
    if (existing) {
      // Re-activate if previously deprovisioned
      if (existing.status === 'Inactive') {
        existing.status = 'Active';
        if (fields.scimExternalId) existing.scimExternalId = fields.scimExternalId;
        await existing.save();
        return res.status(200).json(userToSCIM(existing));
      }
      return res.status(409).json({
        schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'],
        status: '409', detail: `User ${fields.email} already exists.`,
      });
    }

    const user = await User.create(fields);
    res.status(201).set('Location', `/scim/v2/Users/${user._id}`).json(userToSCIM(user));
  } catch (e) {
    res.status(400).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', detail: e.message });
  }
});

// ── GET /scim/v2/Users/:id ────────────────────────────────────────────────────
router.get('/Users/:id', requireSCIM, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'User not found.' });
    res.json(userToSCIM(user));
  } catch {
    res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'User not found.' });
  }
});

// ── PUT /scim/v2/Users/:id ────────────────────────────────────────────────────
router.put('/Users/:id', requireSCIM, async (req, res) => {
  try {
    const fields = scimBodyToUser(req.body);
    const user   = await User.findByIdAndUpdate(req.params.id, fields, { new: true, runValidators: true });
    if (!user) return res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'User not found.' });
    res.json(userToSCIM(user));
  } catch (e) {
    res.status(400).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', detail: e.message });
  }
});

// ── PATCH /scim/v2/Users/:id ──────────────────────────────────────────────────
router.patch('/Users/:id', requireSCIM, async (req, res) => {
  try {
    const ops  = req.body.Operations || [];
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'User not found.' });

    for (const op of ops) {
      const path  = (op.path || '').toLowerCase();
      const value = op.value;

      // active flag (path or value-object)
      if (path === 'active' || (typeof value === 'object' && value !== null && 'active' in value)) {
        const activeVal = path === 'active' ? value : value.active;
        user.status = (activeVal === true || activeVal === 'true') ? 'Active' : 'Inactive';
      }
      if (path === 'username')        { user.email    = (value || '').toLowerCase().trim(); }
      if (path === 'title')           { user.jobTitle  = value || ''; }
      if (path === 'name.givenname')  { user.first    = value || ''; }
      if (path === 'name.familyname') { user.last     = value || ''; }
      if (path === 'externalid')      { user.scimExternalId = value || ''; }

      // Handle object value with no path
      if (!path && typeof value === 'object' && value !== null) {
        if ('active'     in value) user.status         = value.active ? 'Active' : 'Inactive';
        if ('title'      in value) user.jobTitle        = value.title || '';
        if ('externalId' in value) user.scimExternalId  = value.externalId || '';
        if (value.name) {
          if (value.name.givenName)  user.first = value.name.givenName;
          if (value.name.familyName) user.last  = value.name.familyName;
        }
      }
    }

    await user.save();
    res.json(userToSCIM(user));
  } catch (e) {
    res.status(400).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '400', detail: e.message });
  }
});

// ── DELETE /scim/v2/Users/:id — soft deprovision ──────────────────────────────
router.delete('/Users/:id', requireSCIM, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '404', detail: 'User not found.' });
    user.status = 'Inactive';
    await user.save();
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ schemas: ['urn:ietf:params:scim:api:messages:2.0:Error'], status: '500', detail: e.message });
  }
});

module.exports = router;
