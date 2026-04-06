const { decryptSecret } = require('./secret-crypto');

const HEADER_UNSAFE_OR_ZERO_WIDTH_RE = /[\u0000-\u001F\u007F\u200B-\u200D\uFEFF]/g;
const SLACK_BOT_TOKEN_RE = /^xoxb-[A-Za-z0-9-]+$/;

function sanitizeSlackToken(value = '') {
  return String(value || '')
    .replace(HEADER_UNSAFE_OR_ZERO_WIDTH_RE, '')
    .trim();
}

function normalizeSlackBotToken(value = '', opts = {}) {
  const label = String(opts.label || 'Slack Bot Token');
  const token = sanitizeSlackToken(value);
  if (!token) {
    const err = new Error(`${label} is empty or unreadable. Save the connector token again.`);
    err.status = 503;
    throw err;
  }
  if (/\s/.test(token)) {
    const err = new Error(`${label} contains whitespace/line-break characters. Save a clean single-line token.`);
    err.status = 400;
    throw err;
  }
  if (!SLACK_BOT_TOKEN_RE.test(token)) {
    const err = new Error(`${label} is invalid. It must start with "xoxb-" and contain only letters, numbers, and hyphens.`);
    err.status = 400;
    throw err;
  }
  return token;
}

function resolveSlackBotToken(rawValue = '', opts = {}) {
  return normalizeSlackBotToken(decryptSecret(rawValue), opts);
}

module.exports = {
  sanitizeSlackToken,
  normalizeSlackBotToken,
  resolveSlackBotToken,
};
