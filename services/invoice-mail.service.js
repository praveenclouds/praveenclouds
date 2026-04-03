const crypto = require('crypto');
const pdf = require('pdf-parse');

const { IntegrationSettings } = require('../db');
const { httpsPost } = require('../utils/http');
const { decryptSecret } = require('../utils/secret-crypto');

const DEFAULT_QUERY = '(invoice OR receipt OR "tax invoice" OR billing OR statement)';
const SUPPORTED_MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/jpg']);
const SUPPORTED_EXT = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const PDF_MIME = new Set(['application/pdf']);
const MAX_ATTACHMENT_BYTES = Math.max(256 * 1024, Number(process.env.INVOICE_MAIL_MAX_ATTACHMENT_BYTES || (15 * 1024 * 1024)));

function toArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return '';
  const angle = text.match(/<([^>]+)>/);
  const email = angle ? angle[1] : text;
  return email.replace(/^mailto:/i, '').trim().toLowerCase();
}

function emailDomain(email = '') {
  const normalized = normalizeEmail(email);
  const at = normalized.indexOf('@');
  return at > 0 ? normalized.slice(at + 1) : '';
}

function headerValue(headers = [], name = '') {
  const target = String(name || '').trim().toLowerCase();
  const row = toArray(headers).find((h) => String(h?.name || '').trim().toLowerCase() === target);
  return String(row?.value || '').trim();
}

function estimateBase64Bytes(input = '') {
  const clean = String(input || '').replace(/[^A-Za-z0-9+/=_-]/g, '');
  if (!clean) return 0;
  const padChars = clean.endsWith('==') ? 2 : (clean.endsWith('=') ? 1 : 0);
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padChars);
}

function decodeBase64Url(input = '', options = {}) {
  const text = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  if (!text) return Buffer.alloc(0);
  const maxBytes = Number(options?.maxBytes || 0);
  if (maxBytes > 0) {
    const estimated = estimateBase64Bytes(text);
    if (estimated > maxBytes) {
      throw new Error(`Attachment exceeds max size (${maxBytes} bytes)`);
    }
  }
  const pad = text.length % 4;
  const padded = pad ? text + '='.repeat(4 - pad) : text;
  const decoded = Buffer.from(padded, 'base64');
  if (maxBytes > 0 && decoded.length > maxBytes) {
    throw new Error(`Attachment exceeds max size (${maxBytes} bytes)`);
  }
  return decoded;
}

function looksLikeInvoiceAttachment(filename = '', mimeType = '') {
  const name = String(filename || '').trim().toLowerCase();
  const mime = String(mimeType || '').trim().toLowerCase();
  if (mime && SUPPORTED_MIME.has(mime)) return true;
  for (const ext of SUPPORTED_EXT) {
    if (name.endsWith(ext)) return true;
  }
  return false;
}

function sanitizeMailbox(value = '') {
  const mailbox = String(value || '').trim().toLowerCase();
  if (!mailbox) return 'me';
  return mailbox;
}

function buildSinceQualifier(sinceValue) {
  if (!sinceValue) return '';
  const parsed = new Date(sinceValue);
  if (Number.isNaN(parsed.getTime())) return '';
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(parsed.getUTCDate()).padStart(2, '0');
  return `after:${yyyy}/${mm}/${dd}`;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function fetchGoogleAccessToken({ clientId, clientSecret, refreshToken }) {
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail integration missing client credentials or refresh token');
  }

  const tokenData = await httpsPost('oauth2.googleapis.com', '/token', {
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  if (!tokenData?.access_token) {
    const reason = tokenData?.error_description || tokenData?.error || 'unknown error';
    throw new Error(`Unable to refresh Gmail access token: ${reason}`);
  }

  return tokenData.access_token;
}

async function getGmailContext(mailboxOverride = '') {
  const [gmailSettings, googleSettings] = await Promise.all([
    IntegrationSettings.findOne({ provider: 'gmail' }).lean(),
    IntegrationSettings.findOne({ provider: 'google' }).lean(),
  ]);

  if (!gmailSettings?.enabled) {
    throw new Error('Gmail invoice integration is disabled');
  }

  const clientId = String(gmailSettings.clientId || googleSettings?.clientId || '').trim();
  const clientSecret = String(
    decryptSecret(gmailSettings?.clientSecret || '')
    || decryptSecret(googleSettings?.clientSecret || '')
    || ''
  ).trim();
  const refreshToken = String(decryptSecret(gmailSettings?.gmailRefreshToken || '') || '').trim();
  const mailbox = sanitizeMailbox(mailboxOverride || gmailSettings.gmailMailbox || 'me');
  const baseQuery = String(gmailSettings.gmailQuery || DEFAULT_QUERY).trim() || DEFAULT_QUERY;

  const accessToken = await fetchGoogleAccessToken({ clientId, clientSecret, refreshToken });

  return {
    accessToken,
    mailbox,
    baseQuery,
    settings: gmailSettings,
  };
}

async function gmailGet(accessToken, path, params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const url = `https://gmail.googleapis.com/gmail/v1${path}${query.toString() ? `?${query.toString()}` : ''}`;
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const raw = await response.text();
  let payload = null;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw }; }
  if (!response.ok) {
    const detail = payload?.error?.message || payload?.raw || `HTTP ${response.status}`;
    throw new Error(`Gmail API error: ${detail}`);
  }
  return payload;
}

async function listGmailMessages({ accessToken, mailbox = 'me', query = '', limit = 50, since = '' }) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
  const sinceQ = buildSinceQualifier(since);
  const mergedQuery = [String(query || '').trim(), sinceQ].filter(Boolean).join(' ').trim();

  const payload = await gmailGet(accessToken, `/users/${encodeURIComponent(mailbox)}/messages`, {
    maxResults: safeLimit,
    q: mergedQuery,
  });

  return {
    messages: toArray(payload?.messages),
    resultSizeEstimate: Number(payload?.resultSizeEstimate || 0),
    query: mergedQuery,
  };
}

function collectAttachmentParts(part, out = []) {
  if (!part || typeof part !== 'object') return out;

  const filename = String(part.filename || '').trim();
  const mimeType = String(part.mimeType || '').trim();
  const body = part.body || {};
  if (filename && looksLikeInvoiceAttachment(filename, mimeType) && body.attachmentId) {
    out.push({
      filename,
      mimeType,
      size: Number(body.size || 0),
      attachmentId: String(body.attachmentId || '').trim(),
    });
  }

  for (const child of toArray(part.parts)) collectAttachmentParts(child, out);
  return out;
}

async function getGmailMessage({ accessToken, mailbox = 'me', messageId }) {
  if (!messageId) throw new Error('messageId is required');
  return gmailGet(accessToken, `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}`, {
    format: 'full',
  });
}

async function fetchAttachmentBuffer({ accessToken, mailbox = 'me', messageId, attachmentId, inlineData = '', maxBytes = MAX_ATTACHMENT_BYTES }) {
  if (inlineData) return decodeBase64Url(inlineData, { maxBytes });
  if (!attachmentId) throw new Error('attachmentId is required');

  const payload = await gmailGet(
    accessToken,
    `/users/${encodeURIComponent(mailbox)}/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`
  );
  return decodeBase64Url(String(payload?.data || ''), { maxBytes });
}

function toDataUrl(buffer, mimeType = 'application/pdf') {
  const mime = String(mimeType || '').trim() || 'application/pdf';
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

function looksLikePdf(mimeType = '', filename = '') {
  const mime = String(mimeType || '').trim().toLowerCase();
  const file = String(filename || '').trim().toLowerCase();
  if (PDF_MIME.has(mime)) return true;
  return file.endsWith('.pdf');
}

function normalizeTextForMatching(text = '') {
  return String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeBodyText(text = '', maxChars = 120000) {
  const clean = String(text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  if (!clean) return '';
  return clean.slice(0, maxChars);
}

function decodeTextPartData(data = '') {
  if (!data) return '';
  try {
    const buffer = decodeBase64Url(String(data || ''), { maxBytes: 2 * 1024 * 1024 });
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

function htmlEntityDecode(text = '') {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html = '') {
  return htmlEntityDecode(
    String(html || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
      .replace(/<li[^>]*>/gi, '- ')
      .replace(/<[^>]+>/g, ' ')
  );
}

function sanitizeUrlCandidate(url = '') {
  const raw = String(url || '').trim()
    .replace(/^<|>$/g, '')
    .replace(/&amp;/gi, '&');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function extractUrlsFromText(text = '', limit = 100) {
  const out = [];
  const src = String(text || '');
  if (!src) return out;
  const re = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;
  let m;
  while ((m = re.exec(src))) {
    const clean = sanitizeUrlCandidate(m[0]);
    if (!clean) continue;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function extractHrefUrlsFromHtml(html = '', limit = 100) {
  const out = [];
  const src = String(html || '');
  if (!src) return out;
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(src))) {
    const clean = sanitizeUrlCandidate(m[1]);
    if (!clean) continue;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function uniqueUrls(urls = [], limit = 100) {
  const out = [];
  for (const raw of Array.isArray(urls) ? urls : []) {
    const clean = sanitizeUrlCandidate(raw);
    if (!clean) continue;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

function collectBodyParts(part, out = { plain: [], html: [], links: [] }) {
  if (!part || typeof part !== 'object') return out;
  const mimeType = String(part.mimeType || '').trim().toLowerCase();
  const filename = String(part.filename || '').trim();
  const bodyData = String(part?.body?.data || '').trim();

  if (!filename && bodyData) {
    const decoded = decodeTextPartData(bodyData);
    if (decoded) {
      if (mimeType === 'text/plain') {
        out.plain.push(decoded);
        out.links.push(...extractUrlsFromText(decoded, 50));
      } else if (mimeType === 'text/html') {
        out.html.push(decoded);
        out.links.push(...extractHrefUrlsFromHtml(decoded, 50));
        out.links.push(...extractUrlsFromText(decoded, 50));
      } else if (mimeType.startsWith('text/')) {
        out.plain.push(decoded);
        out.links.push(...extractUrlsFromText(decoded, 50));
      }
    }
  }

  for (const child of toArray(part.parts)) collectBodyParts(child, out);
  return out;
}

function extractMessageBodyText(payload = {}, snippet = '') {
  const bodyParts = collectBodyParts(payload, { plain: [], html: [], links: [] });
  const plainText = normalizeBodyText(bodyParts.plain.join('\n\n'));
  if (plainText) return plainText;
  const htmlText = normalizeBodyText(htmlToPlainText(bodyParts.html.join('\n\n')));
  if (htmlText) return htmlText;
  return normalizeBodyText(snippet || '');
}

function extractMessageLinks(payload = {}, snippet = '') {
  const bodyParts = collectBodyParts(payload, { plain: [], html: [], links: [] });
  const snippetLinks = extractUrlsFromText(String(snippet || ''), 25);
  return uniqueUrls([...(bodyParts.links || []), ...snippetLinks], 100);
}

async function extractAttachmentTextForMatching({ buffer, mimeType = '', filename = '' } = {}) {
  if (!buffer || !(buffer instanceof Buffer) || !buffer.length) return '';
  if (!looksLikePdf(mimeType, filename)) return '';
  try {
    const parsed = await pdf(buffer);
    const text = normalizeTextForMatching(parsed?.text || '');
    if (!text) return '';
    return text.slice(0, 120000);
  } catch {
    return '';
  }
}

function parseMessageEnvelope(message = {}) {
  const payload = message.payload || {};
  const headers = toArray(payload.headers);
  const from = headerValue(headers, 'from');
  const fromEmail = normalizeEmail(from);
  const subject = headerValue(headers, 'subject');
  const snippet = String(message.snippet || '').trim();
  const received = headerValue(headers, 'date');
  const receivedAt = received ? new Date(received) : null;
  const parts = collectAttachmentParts(payload, []);
  const bodyText = extractMessageBodyText(payload, snippet);
  const links = extractMessageLinks(payload, snippet);

  return {
    messageId: String(message.id || '').trim(),
    threadId: String(message.threadId || '').trim(),
    historyId: String(message.historyId || '').trim(),
    from,
    fromEmail,
    fromDomain: emailDomain(fromEmail),
    subject,
    snippet,
    bodyText,
    links,
    receivedAt: receivedAt && !Number.isNaN(receivedAt.getTime()) ? receivedAt : null,
    hasPdfAttachment: parts.some((part) => looksLikePdf(part.mimeType, part.filename)),
    parts,
  };
}

function createAttachmentRecord({ messageId, part = {}, buffer }) {
  const mimeType = String(part.mimeType || '').trim() || 'application/pdf';
  const filename = String(part.filename || '').trim() || `invoice-${messageId}`;
  const size = Number(part.size || buffer.length || 0);

  return {
    filename,
    mimeType,
    size,
    attachmentId: String(part.attachmentId || '').trim(),
    hashSha256: sha256(buffer),
    dataUrl: toDataUrl(buffer, mimeType),
  };
}

module.exports = {
  DEFAULT_QUERY,
  normalizeEmail,
  emailDomain,
  getGmailContext,
  listGmailMessages,
  getGmailMessage,
  parseMessageEnvelope,
  fetchAttachmentBuffer,
  createAttachmentRecord,
  extractAttachmentTextForMatching,
  MAX_ATTACHMENT_BYTES,
};
