/**
 * server.js — TerzoCloud Asset Portal  (modular monolith entry point)
 *
 * Start:  node server.js
 * Dev:    npm run dev
 *
 * Environment variables (set in .env or export):
 *   PORT         = 3000
 *   MONGO_URI    = mongodb://127.0.0.1:27017/terzocloud_assets
 *   JWT_SECRET   = <strong-random-secret>   ← required in production
 *   LOG_ACTOR    = Praveen M. (IT Admin)
 *   CORS_ORIGINS = https://portal.terzocloud.com   ← comma-separated, production
 *   NODE_ENV     = production
 */

const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const cookieParser = require('cookie-parser');
const path         = require('path');

const { connect }                     = require('./db');
const { PORT, IS_PROD, CORS_ORIGINS } = require('./config');
const { seedSoftware, seedAdminUser } = require('./seed/software.seed');

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

// ── App setup ──────────────────────────────────────────────────────────────────
const app = express();

// Respect X-Forwarded-* headers when running behind a single reverse proxy.
if (IS_PROD) app.set('trust proxy', 1);

// ── Security headers via helmet ────────────────────────────────────────────────
app.use(helmet({
  // Disable CSP — our single-page HTML files use inline scripts/styles
  contentSecurityPolicy:      false,
  crossOriginEmbedderPolicy:  false,
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

// ── Static files ───────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── Public page routes ─────────────────────────────────────────────────────────
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/support', (req, res) => res.sendFile(path.join(__dirname, 'support.html')));
app.get('/',      (req, res) => res.sendFile(path.join(__dirname, 'user-asset-portal.html')));

// ── API routes ─────────────────────────────────────────────────────────────────
app.use('/api/auth',               authRoutes);
app.use('/api/users',              userRoutes);
app.use('/api/assets',             assetRoutes);
app.use('/api/software',           softwareRoutes);
app.use('/api/logs',               logRoutes);
app.use('/api/support',            supportRoutes);
app.use('/api/slack',              slackRoutes);
app.use('/api/admin/users',        adminUserRoutes);
app.use('/api/admin/integrations', adminIntegrationRoutes);
app.use('/api/admin/scim',         adminScimRoutes);
app.use('/api/admin/connectors',   adminConnectorRoutes);
app.use('/api/admin/role-permissions', adminRolePermissionRoutes);
app.use('/api/admin/slack-workflows', adminSlackWorkflowRoutes);

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

// ── Graceful shutdown ──────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n⚠️   ${signal} received — shutting down gracefully`);
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ── Start — explicit catch so boot errors surface clearly ─────────────────────
connect()
  .then(async () => {
    await seedSoftware();
    await seedAdminUser();
    app.listen(PORT, () =>
      console.log(`🚀  Portal running → http://localhost:${PORT}  [${IS_PROD ? 'production' : 'development'}]`)
    );
  })
  .catch(err => {
    console.error('❌  Failed to start server:', err.message);
    process.exit(1);
  });
