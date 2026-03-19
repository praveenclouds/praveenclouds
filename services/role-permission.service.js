const { RolePermission } = require('../db');

const ROLE_DEFINITIONS = [
  {
    role: 'super_admin',
    label: 'Super Admin',
    description: 'Full access to everything, including portal users, integrations, and role permissions.',
    permissions: {
      viewAllPages: true,
      manageEmployeeUsers: true,
      manageAssets: true,
      manageSoftware: true,
      manageSupportRequests: true,
      manageRequestTypes: true,
      managePortalUsers: true,
      manageIntegrations: true,
      viewActivityLog: true,
      exportData: true,
      manageRolePermissions: true,
    },
  },
  {
    role: 'admin',
    label: 'Admin',
    description: 'Manages employee users, assets, software, and support operations.',
    permissions: {
      viewAllPages: true,
      manageEmployeeUsers: true,
      manageAssets: true,
      manageSoftware: true,
      manageSupportRequests: true,
      manageRequestTypes: true,
      managePortalUsers: false,
      manageIntegrations: false,
      viewActivityLog: true,
      exportData: true,
      manageRolePermissions: false,
    },
  },
  {
    role: 'user',
    label: 'User',
    description: 'Read-only access by default. Enable only the capabilities this role should have.',
    permissions: {
      viewAllPages: true,
      manageEmployeeUsers: false,
      manageAssets: false,
      manageSoftware: false,
      manageSupportRequests: false,
      manageRequestTypes: false,
      managePortalUsers: false,
      manageIntegrations: false,
      viewActivityLog: true,
      exportData: true,
      manageRolePermissions: false,
    },
  },
];

const LEGACY_ROLE_ALIASES = new Set(['viewer', 'it_manager']);

let ensured = false;

function normalizeRoleForDisplay(role) {
  return LEGACY_ROLE_ALIASES.has(String(role || '').trim().toLowerCase()) ? 'user' : role;
}

function defaultRoleConfig(role) {
  return ROLE_DEFINITIONS.find(item => item.role === role) || ROLE_DEFINITIONS.find(item => item.role === 'user');
}

async function ensureRolePermissions() {
  if (!ensured) {
    const existing = await RolePermission.find().select('role').lean();
    const existingRoles = new Set(existing.map(item => item.role));

    const missing = ROLE_DEFINITIONS.filter(definition => !existingRoles.has(definition.role));
    if (missing.length) {
      await RolePermission.insertMany(missing);
    }

    ensured = true;
  }
}

async function getRolePermissionConfig(role) {
  await ensureRolePermissions();

  const normalized = normalizeRoleForDisplay(role);
  const legacyRole = String(role || '').trim().toLowerCase();
  if (LEGACY_ROLE_ALIASES.has(legacyRole)) {
    const config = await RolePermission.findOne({ role: 'user' }).lean();
    const base = config || defaultRoleConfig('user');
    return {
      role: normalized,
      label: base.label,
      description: `${base.description} Legacy ${legacyRole.replace('_', ' ')} accounts now follow the User role configuration.`,
      permissions: { ...(base.permissions || {}) },
      isLegacy: true,
    };
  }

  const config = await RolePermission.findOne({ role: normalized }).lean();
  if (config) return config;
  return defaultRoleConfig(normalized);
}

async function listRolePermissionConfigs() {
  await ensureRolePermissions();
  const configs = await RolePermission.find().sort({ role: 1 }).lean();
  return ROLE_DEFINITIONS.map(definition => (
    configs.find(item => item.role === definition.role) || definition
  ));
}

async function updateRolePermissionConfig(role, input = {}) {
  await ensureRolePermissions();
  const normalized = normalizeRoleForDisplay(role);
  if (!ROLE_DEFINITIONS.find(item => item.role === normalized)) {
    throw new Error('Role not found.');
  }

  const base = defaultRoleConfig(normalized);
  const nextPermissions = Object.fromEntries(
    Object.keys(base.permissions).map(key => [key, !!input.permissions?.[key]])
  );

  if (normalized === 'super_admin') {
    Object.keys(nextPermissions).forEach(key => { nextPermissions[key] = true; });
  }

  const updated = await RolePermission.findOneAndUpdate(
    { role: normalized },
    {
      $set: {
        label: String(input.label || base.label).trim() || base.label,
        description: String(input.description || base.description).trim(),
        permissions: nextPermissions,
      },
    },
    { upsert: true, new: true }
  ).lean();

  return updated;
}

async function getResolvedPermissions(role) {
  const config = await getRolePermissionConfig(role);
  return config.permissions || {};
}

module.exports = {
  ROLE_DEFINITIONS,
  ensureRolePermissions,
  getResolvedPermissions,
  getRolePermissionConfig,
  listRolePermissionConfigs,
  normalizeRoleForDisplay,
  updateRolePermissionConfig,
};
