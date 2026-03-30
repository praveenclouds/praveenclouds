/**
 * server.js — Terzo Asset Portal  (modular monolith entry point)
 *
 * Start:  node start-dev.js
 * Dev:    npm run dev
 *
 * Environment variables (set in .env or export):
 *   PORT         = 3000
 *   MONGO_URI    = mongodb://127.0.0.1:27017/terzo_assets
 *   JWT_SECRET   = <strong-random-secret>   ← required in production
 *   LOG_ACTOR    = Praveen M. (IT Admin)
 *   CORS_ORIGINS = https://portal.terzocloud.com   ← comma-separated, production
 *   NODE_ENV     = production
 */

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const crypto       = require('crypto');
const path         = require('path');

const { connect }                     = require('./db');
const { PORT, IS_PROD, CORS_ORIGINS } = require('./config');
const { seedSoftware, seedAdminUser } = require('./seed/software.seed');
const { seedUsers }                   = require('./seed/users.seed');

// ── Route modules ──────────────────────────────────────────────────────────────
const authRoutes             = require('./routes/auth.routes');
const userRoutes             = require('./routes/users.routes');
const assetRoutes            = require('./routes/assets.routes');
const softwareRoutes         = require('./routes/software.routes');
const logRoutes              = require('./routes/logs.routes');
const supportRoutes          = require('./routes/support.routes');
const slackRoutes            = require('./routes/slack.routes');
const scimRoutes             = require('./routes/scim.routes');
const adminUserRoutes        = require('./routes/admin/users.routes');
const adminIntegrationRoutes = require('./routes/admin/integrations.routes');
const adminScimRoutes        = require('./routes/admin/scim.routes');
const adminConnectorRoutes   = require('./routes/admin/connectors.routes');
const adminRolePermissionRoutes = require('./routes/admin/role-permissions.routes');
const adminSlackWorkflowRoutes = require('./routes/admin/slack-workflows.routes');
const adminDepartmentRoutes    = require('./routes/admin/departments.routes');
const adminAlertRoutes         = require('./routes/admin/alerts.routes');
const sheetSyncRoutes          = require('./routes/sheet-sync.routes');
const { requireAuth, onlySuperAdmin } = require('./middleware/auth');
const { runSupportSlaMonitor } = require('./services/support-notification.service');

// ── App setup ──────────────────────────────────────────────────────────────────
const app = express();
let supportSlaMonitorInterval = null;

// Respect X-Forwarded-* headers when running behind a single reverse proxy.
if (IS_PROD) app.set('trust proxy', 1);

// ── Security headers via helmet ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      // This app still uses inline HTML handlers (onclick/onsubmit) across pages.
      // Allow script attributes so button/form actions execute in browser.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://cdnjs.cloudflare.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "https://cdnjs.cloudflare.com"],
      imgSrc:     ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
      baseUri:    ["'self'"],
      formAction: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — open in dev, origin-restricted in production ───────────────────────
if (IS_PROD && CORS_ORIGINS) {
  app.use(cors({
    origin:      CORS_ORIGINS,
    credentials: true,
    methods:     ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  }));
} else {
  app.use(cors()); // development — allow all origins
}

app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());

// ── Request ID tracing ─────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const incoming = String(req.get('x-request-id') || '').trim();
  const requestId = incoming || crypto.randomUUID();
  req.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  next();
});

// ── CSRF protection ────────────────────────────────────────────────────────────
// Double-submit cookie: generate token on every response, validate on state-changing requests.
function ensureCsrfCookie(req, res) {
  if (!req.cookies._csrf) {
    const csrfToken = crypto.randomBytes(32).toString('hex');
    res.cookie('_csrf', csrfToken, {
      httpOnly: false,  // JS needs to read this to send as header
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
    return csrfToken;
  }
  return req.cookies._csrf;
}
// Set CSRF cookie on ALL requests (including GET) so the token is ready before first POST
app.use((req, res, next) => {
  ensureCsrfCookie(req, res);
  // Only validate on state-changing methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Skip CSRF for SCIM (Bearer token), login (no cookie yet), and sheet-sync webhook
  const csrfBypassPaths = new Set([
    '/api/auth/login',
    '/api/auth/logout',
    '/api/auth/google/callback',
    '/api/v1/auth/login',
    '/api/v1/auth/logout',
    '/api/v1/auth/google/callback',
  ]);
  if (req.path.startsWith('/scim/') ||
      csrfBypassPaths.has(req.path)) {
    return next();
  }
  const cookieToken = req.cookies._csrf;
  const headerToken = req.headers['x-csrf-token'];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  next();
});

// ── Static files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── CSRF token endpoint — provides token for SPA to use ──────────────────────────
app.get('/api/csrf-token', (req, res) => {
  let token = req.cookies._csrf;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie('_csrf', token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  res.json({ csrfToken: token });
});
app.get('/api/v1/csrf-token', (req, res) => {
  let token = req.cookies._csrf;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    res.cookie('_csrf', token, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    });
  }
  res.json({ csrfToken: token });
});

// ── Public page routes ─────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support.html')));
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'user-asset-portal.html')));

// ── API routes ─────────────────────────────────────────────────────────────────
function mountApiRoutes(base = '/api') {
  app.use(`${base}/auth`, authRoutes);
  app.use(`${base}/users`, userRoutes);
  app.use(`${base}/assets`, assetRoutes);
  app.use(`${base}/software`, softwareRoutes);
  app.use(`${base}/logs`, logRoutes);
  app.use(`${base}/support`, supportRoutes);
  app.use(`${base}/slack`, slackRoutes);
  app.use(`${base}/admin/users`, adminUserRoutes);
  app.use(`${base}/admin/integrations`, adminIntegrationRoutes);
  app.use(`${base}/admin/scim`, adminScimRoutes);
  app.use(`${base}/admin/connectors`, adminConnectorRoutes);
  app.use(`${base}/admin/role-permissions`, adminRolePermissionRoutes);
  app.use(`${base}/admin/slack-workflows`, adminSlackWorkflowRoutes);
  app.use(`${base}/admin/departments`, adminDepartmentRoutes);
  app.use(`${base}/admin/alerts`, adminAlertRoutes);
  app.use(`${base}/sheet-sync`, sheetSyncRoutes);
}

mountApiRoutes('/api');
mountApiRoutes('/api/v1');

// ── Inline sheet-sync /run endpoint (reads tmp-sheet-data.json, runs sync) ──
app.get('/api/sheet-sync/run', requireAuth, onlySuperAdmin, async (req, res) => {
  const fs   = require('fs');
  const path = require('path');
  const User     = require('./db/models/User');
  const Software = require('./db/models/Software');
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
  try {
    const filePath = path.join(__dirname, 'tmp-sheet-data.json');
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'tmp-sheet-data.json not found' });
    const sheetData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const [allUsers, allSoftware] = await Promise.all([User.find({}).lean(), Software.find({}).lean()]);
    function getSw(sheetName) {
      const kw = SW_ALIASES[sheetName] || norm(sheetName);
      return allSoftware.find(s => norm(s.name).includes(kw) || kw.includes(norm(s.name).split(' ')[0])) || null;
    }
    const accessMap = new Map();
    const rolesMap  = new Map();
    allUsers.forEach(u => {
      accessMap.set(u._id.toString(), new Set(Array.isArray(u.appAccess) ? u.appAccess : []));
      rolesMap.set(u._id.toString(), { ...(u.appRoles || {}) });
    });
    const report = {}, notInPortal = {};
    for (const [sheetName, shUsers] of Object.entries(sheetData)) {
      const sw = getSw(sheetName);
      report[sheetName] = { csvId: sw?.csvId || '?', total: shUsers.length, matched: 0, missing: [] };
      if (!sw || !shUsers.length) continue;
      for (const zu of shUsers) {
        const u = allUsers.find(x => x.email.toLowerCase() === (zu.email||'').toLowerCase());
        if (!u) { report[sheetName].missing.push(zu.email); (notInPortal[zu.email] = notInPortal[zu.email]||[]).push(sheetName); continue; }
        const uid = u._id.toString();
        accessMap.get(uid).add(sw.csvId);
        rolesMap.get(uid)[sw.csvId] = zu.role || 'Member';
        report[sheetName].matched++;
      }
    }
    let updated = 0, errors = 0;
    for (const u of allUsers) {
      const uid = u._id.toString();
      const newAccess = Array.from(accessMap.get(uid)||[]);
      const newRoles  = rolesMap.get(uid)||{};
      const oldAccess = Array.isArray(u.appAccess) ? u.appAccess : [];
      const changed = newAccess.some(id=>!oldAccess.includes(id)) || oldAccess.some(id=>!newAccess.includes(id)) || JSON.stringify(u.appRoles||{}) !== JSON.stringify(newRoles);
      if (!changed) continue;
      try { await User.findByIdAndUpdate(u._id, { appAccess: newAccess, appRoles: newRoles, $set: { appRoles: newRoles } }); updated++; } catch(e) { errors++; }
    }
    try { fs.unlinkSync(filePath); } catch(_) {}
    res.json({ ok: true, report, notInPortal, updated, errors });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/sheet-sync/run', requireAuth, onlySuperAdmin, async (req, res) => {
  return res.redirect(307, '/api/sheet-sync/run');
});

// ── ONE-TIME migration: fix all legacy location values ─────────────────────────
app.get('/api/migrate-location', requireAuth, onlySuperAdmin, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const col = mongoose.connection.db.collection('users');
    const r1 = await col.updateMany(
      { location: { $in: ['Chennai', 'Coimbatore'] } },
      { $set: { location: 'India' } }
    );
    const r2 = await col.updateMany(
      { location: 'Remote' },
      { $set: { location: 'USA' } }
    );
    res.json({
      ok: true,
      india: { matched: r1.matchedCount, updated: r1.modifiedCount },
      usa:   { matched: r2.matchedCount, updated: r2.modifiedCount },
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/v1/migrate-location', requireAuth, onlySuperAdmin, async (req, res) => {
  return res.redirect(307, '/api/migrate-location');
});

// ── SCIM 2.0 — force application/scim+json content-type ───────────────────────
app.use('/scim/v2', (req, res, next) => {
  res.setHeader('Content-Type', 'application/scim+json');
  next();
}, scimRoutes);

// ── Global error handler ───────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err.message);
  res.status(err.status || 500).json({ error: IS_PROD ? 'Internal server error' : err.message });
});

// ── Global process-level safety nets ──────────────────────────────────────────
// Catch synchronous throws that escaped all try/catch blocks.
process.on('uncaughtException', (err) => {
  console.error('💥  [uncaughtException]', err.stack || err.message);
  // Give active requests ~3 s to drain then exit so the process manager can restart.
  setTimeout(() => process.exit(1), 3000).unref();
});

// Catch unhandled promise rejections (missing .catch(), forgotten await, etc.).
process.on('unhandledRejection', (reason) => {
  console.error('💥  [unhandledRejection]', reason instanceof Error ? reason.stack : reason);
  setTimeout(() => process.exit(1), 3000).unref();
});

// ── Graceful shutdown ──────────────────────────────────────────────────────────
const { disconnect } = require('./db');

function shutdown(signal) {
  console.log(`\n⚠️   ${signal} received — shutting down gracefully`);
  if (supportSlaMonitorInterval) {
    clearInterval(supportSlaMonitorInterval);
    supportSlaMonitorInterval = null;
  }
  // Stop accepting new connections, drain in-flight requests, then close DB.
  if (global._httpServer) {
    global._httpServer.close(async () => {
      try { await disconnect(); } catch (_) { /* ignore */ }
      console.log('👋  Server closed cleanly');
      process.exit(0);
    });
    // Hard-exit fallback after 10 s if close() stalls.
    setTimeout(() => { console.error('⚠️  Force-exit after timeout'); process.exit(1); }, 10_000).unref();
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Auto-start in-memory MongoDB if no external URI is configured ──────────────
async function ensureMongoDB() {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI || '';
  if (!uri) {
    try {
      const { MongoMemoryServer } = require('mongodb-memory-server');
      console.log('🔧  Starting in-memory MongoDB…');
      const mongod = await MongoMemoryServer.create({ instance: { dbName: 'terzo_assets' } });
      process.env.MONGO_URI = mongod.getUri();
      console.log(`✅  In-memory MongoDB ready → ${process.env.MONGO_URI}`);
    } catch (err) {
      if (err.message && err.message.includes('already in use')) {
        console.log('ℹ️   MongoDB already running — connecting to existing instance');
        process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/terzo_assets';
      } else {
        throw err;
      }
    }
  }
}

// ── Start — explicit catch so boot errors surface clearly ─────────────────────
ensureMongoDB()
  .then(() => connect())
  .then(async () => {
    await seedSoftware();
    await seedAdminUser();
    await seedUsers();
    const server = app.listen(PORT, () =>
      console.log(`🚀  Portal running → http://localhost:${PORT}  [${IS_PROD ? 'production' : 'development'}]`)
    );
    // Store reference so graceful shutdown can call server.close().
    global._httpServer = server;

    // ── Atlas M0 keepalive ────────────────────────────────────────────────────
    // Atlas free-tier clusters auto-pause after prolonged inactivity.
    // Ping the DB every 5 minutes to keep the connection alive.
    const mongoose = require('mongoose');
    setInterval(async () => {
      try {
        await mongoose.connection.db.admin().ping();
      } catch (e) {
        console.warn('⚠️  [keepalive] DB ping failed:', e.message);
      }
    }, 5 * 60 * 1000); // every 5 minutes

    const monitorIntervalMs = Math.max(Number(process.env.SUPPORT_SLA_MONITOR_MS || 60_000) || 60_000, 15_000);
    supportSlaMonitorInterval = setInterval(async () => {
      try {
        const stats = await runSupportSlaMonitor();
        if ((stats?.alertsSent || 0) || (stats?.remindersSent || 0) || (stats?.escalations || 0)) {
          console.log(
            `ℹ️  [sla monitor] processed=${stats.processed || 0} updated=${stats.updated || 0} alerts=${stats.alertsSent || 0} reminders=${stats.remindersSent || 0} escalations=${stats.escalations || 0}`
          );
        }
      } catch (error) {
        console.warn('⚠️  [sla monitor] run failed:', error.message);
      }
    }, monitorIntervalMs);
    supportSlaMonitorInterval.unref?.();
    runSupportSlaMonitor().catch(error => {
      console.warn('⚠️  [sla monitor] initial run failed:', error.message);
    });
  })
  .catch(err => {
    console.error('❌  Failed to start server:', err.message);
    process.exit(1);
  });
