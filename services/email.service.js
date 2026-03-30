const nodemailer = require('nodemailer');
const { IntegrationSettings } = require('../db');
const { PORT } = require('../config');

function sanitizeBaseUrl(value) {
  return String(value || '')
    .trim()
    .replace(/\/+$/, '');
}

async function loadEmailSettings() {
  const settings = await IntegrationSettings.findOne({ provider: 'email' }).lean();
  return {
    enabled: !!settings?.enabled,
    smtpHost: String(settings?.smtpHost || '').trim(),
    smtpPort: Number(settings?.smtpPort || 587),
    smtpSecure: !!settings?.smtpSecure,
    smtpUser: String(settings?.smtpUser || '').trim(),
    smtpPass: String(settings?.smtpPass || '').trim(),
    fromEmail: String(settings?.fromEmail || '').trim(),
    fromName: String(settings?.fromName || 'Terzo Support').trim(),
    appBaseUrl: sanitizeBaseUrl(settings?.appBaseUrl || process.env.APP_BASE_URL || `http://localhost:${PORT}`),
  };
}

function emailConfigured(settings) {
  return !!(
    settings.enabled
    && settings.smtpHost
    && settings.smtpPort
    && settings.fromEmail
  );
}

async function createTransporter(settings) {
  const auth = settings.smtpUser
    ? { user: settings.smtpUser, pass: settings.smtpPass }
    : undefined;

  return nodemailer.createTransport({
    host: settings.smtpHost,
    port: settings.smtpPort,
    secure: settings.smtpSecure,
    auth,
  });
}

async function sendMail(message = {}) {
  const settings = await loadEmailSettings();
  if (!emailConfigured(settings)) {
    return { ok: false, skipped: true, reason: 'email_not_configured', settings };
  }

  const transporter = await createTransporter(settings);
  await transporter.sendMail({
    from: settings.fromName
      ? `"${settings.fromName.replace(/"/g, '\\"')}" <${settings.fromEmail}>`
      : settings.fromEmail,
    ...message,
  });

  return { ok: true, skipped: false, settings };
}

module.exports = {
  emailConfigured,
  loadEmailSettings,
  sendMail,
};
