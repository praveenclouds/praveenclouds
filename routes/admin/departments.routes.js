const router = require('express').Router();
const { Department, User } = require('../../db');
const { requireAuth, canWriteUsers } = require('../../middleware/auth');
const { writeLog } = require('../../services/log.service');

function normalizeDeptName(value = '') {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function fmtDepartment(doc) {
  return {
    id: doc._id.toString(),
    name: doc.name,
    isActive: doc.isActive !== false,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

async function ensureDepartmentsSeededFromUsers() {
  const rows = await User.aggregate([
    { $match: { dept: { $exists: true, $ne: null, $ne: '' } } },
    { $group: { _id: '$dept' } },
  ]);
  const names = [...new Set(rows.map(row => normalizeDeptName(row._id)).filter(Boolean))];
  if (!names.length) return;

  const existing = await Department.find({ name: { $in: names } }).select('name').lean();
  const existingSet = new Set(existing.map(item => normalizeDeptName(item.name).toLowerCase()));
  const missing = names
    .filter(name => !existingSet.has(name.toLowerCase()))
    .map(name => ({ name, createdBy: 'system', updatedBy: 'system' }));
  if (missing.length) await Department.insertMany(missing, { ordered: false });
}

router.get('/', requireAuth, async (req, res) => {
  try {
    await ensureDepartmentsSeededFromUsers();
    const departments = await Department.find({}).sort({ name: 1 }).lean();
    res.json(departments.map(fmtDepartment));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const name = normalizeDeptName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const actor = req.user?.name || req.user?.email || 'unknown';
    const department = await Department.create({
      name,
      createdBy: actor,
      updatedBy: actor,
    });
    await writeLog({
      eventType: 'department_created',
      entityType: 'department',
      entityId: department._id.toString(),
      entityLabel: department.name,
      actorName: actor,
      summary: `Department created: ${department.name}`,
    });
    res.status(201).json(fmtDepartment(department));
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Department already exists' });
    res.status(400).json({ error: error.message });
  }
});

router.put('/:id', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const name = normalizeDeptName(req.body?.name);
    if (!name) return res.status(400).json({ error: 'Department name is required' });
    const actor = req.user?.name || req.user?.email || 'unknown';
    const department = await Department.findByIdAndUpdate(
      req.params.id,
      { name, updatedBy: actor },
      { new: true, runValidators: true }
    );
    if (!department) return res.status(404).json({ error: 'Department not found' });
    await writeLog({
      eventType: 'department_updated',
      entityType: 'department',
      entityId: department._id.toString(),
      entityLabel: department.name,
      actorName: actor,
      summary: `Department updated: ${department.name}`,
    });
    res.json(fmtDepartment(department));
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Department already exists' });
    res.status(400).json({ error: error.message });
  }
});

router.delete('/:id', requireAuth, canWriteUsers, async (req, res) => {
  try {
    const actor = req.user?.name || req.user?.email || 'unknown';
    const department = await Department.findByIdAndDelete(req.params.id);
    if (!department) return res.status(404).json({ error: 'Department not found' });
    await writeLog({
      eventType: 'department_deleted',
      entityType: 'department',
      entityId: req.params.id,
      entityLabel: department.name,
      actorName: actor,
      summary: `Department deleted: ${department.name}`,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;

