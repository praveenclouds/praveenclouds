const mongoose = require('mongoose');

const ROLE_KEYS = ['super_admin', 'admin', 'user'];

const PERMISSION_DEFINITIONS = [
  { key: 'viewAllPages', label: 'View all pages', description: 'Open the user portal and support pages.' },
  { key: 'manageEmployeeUsers', label: 'Add / Edit / Delete Users', description: 'Manage employee users in User Management.' },
  { key: 'manageAssets', label: 'Add / Edit / Delete Assets', description: 'Create, update, and remove asset inventory records.' },
  { key: 'manageSoftware', label: 'Add / Edit / Delete Software', description: 'Create, update, and remove software inventory records.' },
  { key: 'manageSupportRequests', label: 'Manage support requests', description: 'Create, edit, and delete support requests.' },
  { key: 'manageRequestTypes', label: 'Manage request types', description: 'Edit request types and workflow builders in Support Center.' },
  { key: 'managePortalUsers', label: 'Manage portal users', description: 'Create and maintain Admin Console portal user accounts.' },
  { key: 'manageIntegrations', label: 'Manage integrations', description: 'Edit Integrations, SCIM, and connector settings.' },
  { key: 'viewActivityLog', label: 'View activity log', description: 'Open the Activity Log page and API.' },
  { key: 'exportData', label: 'Export CSV / PDF', description: 'Use export actions across the portals.' },
  { key: 'manageRolePermissions', label: 'Edit role permissions', description: 'Open Roles & Permissions and save role changes.' },
];

const permissionSchemaShape = Object.fromEntries(
  PERMISSION_DEFINITIONS.map(permission => [permission.key, { type: Boolean, default: false }])
);

const rolePermissionSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ROLE_KEYS, unique: true, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    description: { type: String, default: '', trim: true },
    permissions: {
      type: new mongoose.Schema(permissionSchemaShape, { _id: false }),
      default: () => ({}),
    },
  },
  { timestamps: true }
);

const RolePermission = mongoose.model('RolePermission', rolePermissionSchema);

module.exports = RolePermission;
module.exports.ROLE_KEYS = ROLE_KEYS;
module.exports.PERMISSION_DEFINITIONS = PERMISSION_DEFINITIONS;
