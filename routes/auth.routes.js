/**
 * routes/auth.routes.js — Authentication routes
 *
 * POST /api/auth/login           — email + password login → JWT
 * GET  /api/auth/me              — validate token, return current user
 * GET  /api/auth/google/status   — is Google SSO configured?
 * GET  /api/auth/google          — initiate Google OAuth2 flow (with CSRF state)
 * GET  /api/auth/google/callback — exchange code, validate state, issue JWT
 *
 * Security:
 *   - Login route is rate-limited (10 attempts / 15 min per IP)
 *   - Google OAuth uses a random `state` cookie to prevent CSRF
 */
const router      = require('express').Router();
const jwt         = require('jsonwebtoken');
const crypto      = require('crypto');
const rateLimit   = require('express-rate-limit');
const { AdminUser, IntegrationSettings } = require('../db');
const { requireAuth }                    = require('../middleware/auth');
const { JWT_SECRET, JWT_EXPIRES }        = require('../config');
const { httpsGet, httpsPost }            = require('../utils/http');
const { getResolvedPermissions, normalizeRoleForDisplay } = require('../services/role-permission.service');
const { decryptSecret } = require('../utils/secret-crypto');

function getPublicBaseUrl(req) {
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${req.protocol}://${host}`;
}

// ── Rate limiter — max 10 login attempts per IP per 15 minutes ────────────────
const loginLimiter = rateLimit({
  windowMs:         15 * 60 * 1000, // 15 minutes
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many login attempts. Please try again in 15 minutes.' },
  skipSuccessfulRequests: true,      // only count failures
});

// ── POST /api/auth/login ───────────────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'Email and password are required' });

    const user = await AdminUser.findOne({ email: email.toLowerCase().trim() });
    if (!user)
      return res.status(401).json({ error: 'Invalid email or password' });
    if (user.status === 'Inactive')
      return res.status(403).json({ error: 'Your account is disabled. Contact a Super Admin.' });

    const match = await user.comparePassword(password);
    if (!match)
      return res.status(401).json({ error: 'Invalid email or password' });

    user.lastLogin = new Date();
    await user.save();

    const permissions = await getResolvedPermissions(user.role);
    const payload = { id: user._id.toString(), email: user.email, name: user.name, role: user.role };
    const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    // Set JWT as HttpOnly cookie for security (prevents XSS token theft)
    res.cookie('token', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   24 * 60 * 60 * 1000, // 24 hours
      path:     '/',
    });
    res.json({
      token,
      user: {
        id: payload.id,
        name: user.name,
        email: user.email,
        role: normalizeRoleForDisplay(user.role),
        rawRole: user.role,
        permissions,
      },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/auth/me ───────────────────────────────────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await AdminUser.findById(req.user.id).select('-password').lean();
    if (!user) return res.status(404).json({ error: 'User not found' });
    const permissions = await getResolvedPermissions(user.role);
    res.json({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: normalizeRoleForDisplay(user.role),
      rawRole: user.role,
      status: user.status,
      permissions,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/auth/logout ──────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'lax', path: '/' });
  res.json({ ok: true });
});

// ── GET /api/auth/google/status ────────────────────────────────────────────────
router.get('/google/status', async (req, res) => {
  try {
    const s = await IntegrationSettings.findOne({ provider: 'google' });
    const clientSecret = String(decryptSecret(s?.clientSecret || '') || '').trim();
    res.json({ enabled: !!(s && s.enabled && s.clientId && clientSecret) });
  } catch { res.json({ enabled: false }); }
});

// ── GET /api/auth/google — initiate OAuth2 flow ────────────────────────────────
router.get('/google', async (req, res) => {
  try {
    const s = await IntegrationSettings.findOne({ provider: 'google' });
    if (!s || !s.enabled || !s.clientId) return res.redirect('/login?sso_error=disabled');

    // Generate a random CSRF state token, store in HttpOnly cookie (10 min TTL)
    const state       = crypto.randomBytes(20).toString('hex');
    const stateExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes

    res.cookie('oauth_state', `${state}:${stateExpiry}`, {
      httpOnly: true,
      sameSite: 'lax',
      maxAge:   600_000, // 10 minutes in ms
      secure:   req.secure || req.headers['x-forwarded-proto'] === 'https',
    });

    const redirectUri = `${getPublicBaseUrl(req)}/api/auth/google/callback`;
    const params = new URLSearchParams({
      client_id:     s.clientId,
      redirect_uri:  redirectUri,
      response_type: 'code',
      scope:         'openid email profile',
      access_type:   'online',
      prompt:        'select_account',
      state,                          // ← CSRF protection
    });
    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch { res.redirect('/login?sso_error=server'); }
});

// ── GET /api/auth/google/callback ─────────────────────────────────────────────
router.get('/google/callback', async (req, res) => {
  try {
    const { code, error: oauthErr, state: returnedState } = req.query;
    if (oauthErr) return res.redirect('/login?sso_error=denied');
    if (!code)    return res.redirect('/login?sso_error=nocode');

    // ── Validate CSRF state ────────────────────────────────────────────────────
    const cookieVal = req.cookies?.oauth_state || '';
    const [savedState, savedExpiry] = cookieVal.split(':');
    res.clearCookie('oauth_state');   // consume immediately (one-time use)

    if (
      !returnedState ||
      !savedState    ||
      returnedState !== savedState ||
      Date.now() > parseInt(savedExpiry || '0', 10)
    ) {
      console.warn('[AUTH] OAuth state mismatch — possible CSRF attempt');
      return res.redirect('/login?sso_error=state');
    }
    // ──────────────────────────────────────────────────────────────────────────

    const s = await IntegrationSettings.findOne({ provider: 'google' });
    const clientSecret = String(decryptSecret(s?.clientSecret || '') || '').trim();
    if (!s || !s.enabled || !s.clientId || !clientSecret) return res.redirect('/login?sso_error=disabled');

    const redirectUri = `${getPublicBaseUrl(req)}/api/auth/google/callback`;

    // Exchange code for access token
    const tokenData = await httpsPost('oauth2.googleapis.com', '/token', {
      code,
      client_id:     s.clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
    });
    if (tokenData.error) return res.redirect('/login?sso_error=token');

    // Get Google profile
    const profile = await httpsGet(
      `https://www.googleapis.com/oauth2/v2/userinfo?access_token=${encodeURIComponent(tokenData.access_token)}`
    );
    if (!profile.email) return res.redirect('/login?sso_error=noemail');

    // Domain restriction check
    if (s.allowedDomain) {
      const domain = profile.email.split('@')[1] || '';
      if (domain.toLowerCase() !== s.allowedDomain.toLowerCase())
        return res.redirect('/login?sso_error=domain');
    }

    // Must already exist as a portal admin user
    const adminUser = await AdminUser.findOne({ email: profile.email.toLowerCase() });
    if (!adminUser)                  return res.redirect('/login?sso_error=notfound');
    if (adminUser.status === 'Inactive') return res.redirect('/login?sso_error=inactive');

    adminUser.lastLogin = new Date();
    await adminUser.save();

    const payload = { id: adminUser._id.toString(), email: adminUser.email, name: adminUser.name, role: adminUser.role };
    const token   = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    // Set JWT as HttpOnly cookie
    res.cookie('token', token, {
      httpOnly: true,
      secure:   process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge:   24 * 60 * 60 * 1000,
      path:     '/',
    });
    res.redirect(`/login?sso_token=${encodeURIComponent(token)}`);
  } catch (e) {
    console.error('[AUTH] Google OAuth callback error:', e.message);
    res.redirect('/login?sso_error=server');
  }
});

module.exports = router;
