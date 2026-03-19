const router = require('express').Router();
const { requireAuth, canManageRolePermissions } = require('../../middleware/auth');
const {
  ROLE_DEFINITIONS,
  listRolePermissionConfigs,
  updateRolePermissionConfig,
} = require('../../services/role-permission.service');

router.get('/', requireAuth, canManageRolePermissions, async (req, res) => {
  try {
    const roles = await listRolePermissionConfigs();
    res.json({
      roles,
      defaults: ROLE_DEFINITIONS,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.put('/:role', requireAuth, canManageRolePermissions, async (req, res) => {
  try {
    const role = await updateRolePermissionConfig(req.params.role, req.body || {});
    res.json(role);
  } catch (error) {
    res.status(error.message === 'Role not found.' ? 404 : 400).json({ error: error.message });
  }
});

module.exports = router;
