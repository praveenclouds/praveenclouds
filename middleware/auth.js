/**
 * middleware/auth.js — JWT authentication and role-based access control
 *
 * Exports:
 *   requireAuth       — verifies Bearer JWT, sets req.user
 *   requireRole(...)          — checks req.user.role against allowed list
 *   requirePermission(name)   — checks role permission settings from DB
 *   canWrite                  — manage support requests
 *   canWriteUsers             — manage employee users
 *   canWriteSoftware          — manage software
 *   canWriteAssets            — manage assets
 *   canManagePortalUsers      — manage admin console users
 *   canManageIntegrations     — manage integrations / SCIM / connectors
 *   canManageRolePermissions  — edit role permissions
 *   canViewActivityLog        — view logs
 *   onlySuperAdmin            — super_admin only
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');
const { getResolvedPermissions } = require('../services/role-permission.service');

function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (roles.length && !roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient permissions' });
    next();
  };
}

function requirePermission(permissionKey) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    try {
      const permissions = await getResolvedPermissions(req.user.role);
      req.user.permissions = permissions;
      if (!permissions?.[permissionKey]) {
        return res.status(403).json({ error: 'Insufficient permissions' });
      }
      next();
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };
}

const canWrite                = requirePermission('manageSupportRequests');
const canWriteUsers           = requirePermission('manageEmployeeUsers');
const canWriteSoftware        = requirePermission('manageSoftware');
const canWriteAssets          = requirePermission('manageAssets');
const canManagePortalUsers    = requirePermission('managePortalUsers');
const canManageIntegrations   = requirePermission('manageIntegrations');
const canManageRolePermissions = requirePermission('manageRolePermissions');
const canViewActivityLog      = requirePermission('viewActivityLog');
const onlySuperAdmin   = requireRole('super_admin');

module.exports = {
  requireAuth,
  requireRole,
  requirePermission,
  canWrite,
  canWriteUsers,
  canWriteSoftware,
  canWriteAssets,
  canManagePortalUsers,
  canManageIntegrations,
  canManageRolePermissions,
  canViewActivityLog,
  onlySuperAdmin,
};
