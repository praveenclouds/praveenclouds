/**
 * sheet-sync.routes.js  — TEMPORARY route for one-time sheet sync
 * POST /api/sheet-sync         — open CORS so it can be called from any tab
 * GET  /api/sheet-sync/run     — read tmp-sheet-data.json and run sync
 * Body: { sheetData: { SheetName: [{email, role}] } }
 */
const express  = require('express');
const router   = express.Router();
const path     = require('path');
const fs       = require('fs');
const User     = require('../db/models/User');
const Software = require('../db/models/Software');
const { requireAuth, onlySuperAdmin } = require('../middleware/auth');

const SW_ALIASES = {
  'Canva':'canva','Slack':'slack','Asana':'asana','Zoom':'zoom',
  'Adobe':'adobe','Microsoft365':'microsoft','Loom':'loom','OpenVPN':'openvpn',
  'Gsuite':'google','Hubspot':'hubspot','AWS':'aws','intellij':'intellij',
  'Gong':'gong','vercel':'vercel','Chatgpt':'chatgpt','Freshteam':'freshteam',
  'Plaid':'plaid','Github':'github','Productboard':'productboard','Jira':'jira',
  'Datadog':'datadog','Docusign':'docusign','Sendgrid':'sendgrid',
  'Windsurf':'windsurf','Jenkins':'jenkins','ChatPRD':'chatprd','Miro':'miro',
};

const norm = s => (s||'').toLowerCase().trim();

// CORS handled by global middleware — no open wildcard

router.post('/', requireAuth, onlySuperAdmin, async (req, res) => {
  try {
    const { sheetData } = req.body;
    if (!sheetData) return res.status(400).json({ error: 'sheetData required' });

    const [allUsers, allSoftware] = await Promise.all([
      User.find({}).lean(),
      Software.find({}).lean(),
    ]);

    function getSw(sheetName) {
      const kw = SW_ALIASES[sheetName] || norm(sheetName);
      return allSoftware.find(s => norm(s.name).includes(kw) || kw.includes(norm(s.name).split(' ')[0])) || null;
    }

    // Build maps seeded from existing data
    const accessMap = new Map();
    const rolesMap  = new Map();
    allUsers.forEach(u => {
      accessMap.set(u._id.toString(), new Set(Array.isArray(u.appAccess) ? u.appAccess : []));
      rolesMap.set(u._id.toString(),  { ...(u.appRoles || {}) });
    });

    const report     = {};
    const notInPortal = {};

    for (const [sheetName, shUsers] of Object.entries(sheetData)) {
      const sw = getSw(sheetName);
      report[sheetName] = { csvId: sw?.csvId || '?', total: shUsers.length, matched: 0, missing: [] };
      if (!sw || !shUsers.length) continue;

      for (const zu of shUsers) {
        const u = allUsers.find(x => x.email.toLowerCase() === (zu.email||'').toLowerCase());
        if (!u) {
          report[sheetName].missing.push(zu.email);
          if (!notInPortal[zu.email]) notInPortal[zu.email] = [];
          notInPortal[zu.email].push(sheetName);
          continue;
        }
        const uid = u._id.toString();
        accessMap.get(uid).add(sw.csvId);
        rolesMap.get(uid)[sw.csvId] = zu.role || 'Member';
        report[sheetName].matched++;
      }
    }

    // Persist all updates
    let updated = 0, errors = 0;
    for (const u of allUsers) {
      const uid       = u._id.toString();
      const newAccess = Array.from(accessMap.get(uid) || []);
      const newRoles  = rolesMap.get(uid) || {};
      const oldAccess = Array.isArray(u.appAccess) ? u.appAccess : [];
      const changed   = newAccess.some(id => !oldAccess.includes(id))
                      || oldAccess.some(id => !newAccess.includes(id))
                      || JSON.stringify(u.appRoles || {}) !== JSON.stringify(newRoles);
      if (!changed) continue;
      try {
        await User.findByIdAndUpdate(u._id, {
          appAccess: newAccess,
          appRoles:  newRoles,
          $set: { appRoles: newRoles },
        });
        updated++;
      } catch(e) { errors++; }
    }

    res.json({ ok: true, report, notInPortal, updated, errors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/sheet-sync/run — read tmp-sheet-data.json and run the sync ──────
router.get('/run', requireAuth, onlySuperAdmin, async (req, res) => {
  try {
    const filePath = path.join(__dirname, '..', 'tmp-sheet-data.json');
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'tmp-sheet-data.json not found. Write sheet data to file first.' });
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const sheetData = JSON.parse(raw);

    const [allUsers, allSoftware] = await Promise.all([
      User.find({}).lean(),
      Software.find({}).lean(),
    ]);

    function getSw(sheetName) {
      const kw = SW_ALIASES[sheetName] || norm(sheetName);
      return allSoftware.find(s => norm(s.name).includes(kw) || kw.includes(norm(s.name).split(' ')[0])) || null;
    }

    const accessMap = new Map();
    const rolesMap  = new Map();
    allUsers.forEach(u => {
      accessMap.set(u._id.toString(), new Set(Array.isArray(u.appAccess) ? u.appAccess : []));
      rolesMap.set(u._id.toString(),  { ...(u.appRoles || {}) });
    });

    const report      = {};
    const notInPortal = {};

    for (const [sheetName, shUsers] of Object.entries(sheetData)) {
      const sw = getSw(sheetName);
      report[sheetName] = { csvId: sw?.csvId || '?', total: shUsers.length, matched: 0, missing: [] };
      if (!sw || !shUsers.length) continue;

      for (const zu of shUsers) {
        const u = allUsers.find(x => x.email.toLowerCase() === (zu.email||'').toLowerCase());
        if (!u) {
          report[sheetName].missing.push(zu.email);
          if (!notInPortal[zu.email]) notInPortal[zu.email] = [];
          notInPortal[zu.email].push(sheetName);
          continue;
        }
        const uid = u._id.toString();
        accessMap.get(uid).add(sw.csvId);
        rolesMap.get(uid)[sw.csvId] = zu.role || 'Member';
        report[sheetName].matched++;
      }
    }

    let updated = 0, errors = 0;
    for (const u of allUsers) {
      const uid       = u._id.toString();
      const newAccess = Array.from(accessMap.get(uid) || []);
      const newRoles  = rolesMap.get(uid) || {};
      const oldAccess = Array.isArray(u.appAccess) ? u.appAccess : [];
      const changed   = newAccess.some(id => !oldAccess.includes(id))
                      || oldAccess.some(id => !newAccess.includes(id))
                      || JSON.stringify(u.appRoles || {}) !== JSON.stringify(newRoles);
      if (!changed) continue;
      try {
        await User.findByIdAndUpdate(u._id, {
          appAccess: newAccess,
          appRoles:  newRoles,
          $set: { appRoles: newRoles },
        });
        updated++;
      } catch(e) { errors++; }
    }

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch(_) {}

    res.json({ ok: true, report, notInPortal, updated, errors });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
