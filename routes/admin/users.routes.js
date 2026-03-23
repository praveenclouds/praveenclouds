/**
 * routes/admin/users.routes.js — Portal User Management (super_admin only)
 *
 * GET    /api/admin/users
 * POST   /api/admin/users
 * PUT    /api/admin/users/:id
 * PUT    /api/admin/users/:id/reset-password
 * DELETE /api/admin/users/:id
 */
const router = require('express').Router();
const { AdminUser } = require('../../db');
const { requireAuth, canManagePortalUsers } = require('../../middleware/auth');
const { normalizeRoleForDisplay } = require('../../services/role-permission.service');

// ── GET /api/admin/users ───────────────────────────────────────────────────────
router.get('/', requireAuth, canManagePortalUsers, async (req, res) => {
  try {
    const users = await AdminUser.find().select('-password').sort({ createdAt: 1 }).lean();
    res.json(users.map(u => ({
      id:        u._id.toString(),
      name:      u.name,
      email:     u.email,
      role:      normalizeRoleForDisplay(u.role),
      status:    u.status,
      lastLogin: u.lastLogin,
      createdAt: u.createdAt,
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/admin/users ──────────────────────────────────────────────────────
router.post('/', requireAuth, canManagePortalUsers, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ error: 'name, email and password are required' });

    const user = await AdminUser.create({ name, email, password, role: role || 'user' });
    res.status(201).json({
      id: user._id.toString(), name: user.name, email: user.email,
      role: normalizeRoleForDisplay(user.role), status: user.status,
    });
  } catch (e) {
    if (e.code === 11000) return res.status(409).json({ error: 'Email already exists' });
    res.status(400).json({ error: e.message });
  }
});

// ── PUT /api/admin/users/:id ───────────────────────────────────────────────────
router.put('/:id', requireAuth, canManagePortalUsers, async (req, res) => {
  try {
    const { name, email, role, status } = req.body;
    const user = await AdminUser.findByIdAndUpdate(
      req.params.id,
      { name, email, role, status },
      { new: true, runValidators: true }
    ).select('-password');
    if (!user) return res.status(404).json({ error: 'Portal user not found' });
    res.json({ id: user._id.toString(), name: user.name, email: user.email, role: normalizeRoleForDisplay(user.role), status: user.status });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/admin/users/:id/reset-password ────────────────────────────────────
// Minimum 10 chars; must include uppercase, lowercase, a digit, and a special char.
const PASSWORD_RE = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{10,}$/;

router.put('/:id/reset-password', requireAuth, canManagePortalUsers, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || !PASSWORD_RE.test(password))
      return res.status(400).json({
        error: 'Password must be at least 10 characters and include uppercase, lowercase, a number, and a special character',
      });

    const user = await AdminUser.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'Portal user not found' });

    user.password = password; // pre-save hook hashes it
    await user.save();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /api/admin/users/:id ────────────────────────────────────────────────
router.delete('/:id', requireAuth, canManagePortalUsers, async (req, res) => {
  try {
    if (req.params.id === req.user.id)
      return res.status(400).json({ error: 'You cannot delete your own account' });

    const user = await AdminUser.findByIdAndDelete(req.params.id);
    if (!user) return res.status(404).json({ error: 'Portal user not found' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
