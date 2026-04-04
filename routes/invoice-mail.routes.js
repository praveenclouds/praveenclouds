const crypto = require('crypto');
const router = require('express').Router();

const { Software, MailInvoiceRule, MailInvoiceEvent, MailInvoiceBlob, IntegrationSettings } = require('../db');
const { requireAuth, canManageIntegrations } = require('../middleware/auth');
const { getResolvedPermissions } = require('../services/role-permission.service');
const { writeLog } = require('../services/log.service');
const { parseInvoicePDF } = require('../utils/invoice-parser');
const {
  getGmailContext,
  listGmailMessages,
  getGmailMessage,
  parseMessageEnvelope,
  fetchAttachmentBuffer,
  createAttachmentRecord,
  extractAttachmentTextForMatching,
  MAX_ATTACHMENT_BYTES,
} = require('../services/invoice-mail.service');

const softwareRoutes = require('./software.routes');
const extractInvoiceFields = softwareRoutes.extractInvoiceFields;
const deriveAdditionalServicesFromLineItems = softwareRoutes.deriveAdditionalServicesFromLineItems;

const SOFTWARE_FALLBACK_HINTS = {
  adobe: {
    aliases: ['adobe', 'acrobat', 'creative cloud', 'adobe sign', 'adobesign'],
    domains: ['adobe.com', 'adobesign.com'],
  },
  'microsoft 365': {
    aliases: ['microsoft 365', 'office 365', 'microsoft365', 'm365', 'ms365'],
    domains: ['microsoft.com', 'office.com', 'office365.com', 'microsoftonline.com'],
  },
  figma: {
    aliases: ['figma'],
    domains: ['figma.com'],
  },
  miro: {
    aliases: ['miro'],
    domains: ['miro.com'],
  },
};

const FALLBACK_AUTO_ATTACH_THRESHOLD = Math.max(0, Math.min(100, Number(process.env.INVOICE_MAIL_FALLBACK_AUTO_ATTACH_THRESHOLD || 92)));
const FALLBACK_REVIEW_THRESHOLD_RAW = Math.max(0, Math.min(100, Number(process.env.INVOICE_MAIL_FALLBACK_REVIEW_THRESHOLD || 55)));
const FALLBACK_REVIEW_THRESHOLD = Math.min(FALLBACK_REVIEW_THRESHOLD_RAW, FALLBACK_AUTO_ATTACH_THRESHOLD);
const ALLOW_IMAGE_ATTACHMENTS = String(process.env.INVOICE_MAIL_ALLOW_IMAGE_ATTACHMENTS || 'false').trim().toLowerCase() === 'true';
const INVOICE_SIGNAL_RE = /\b(invoice|tax\s+invoice|receipt|billing|bill\s*#|statement|payment|cost|subscription|renewal)\b/i;
const SENDER_PRIORITY_SCORE = 90;

function toLowerList(values = []) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean))];
}

function domainMatches(senderDomain = '', ruleDomain = '') {
  const sender = String(senderDomain || '').trim().toLowerCase();
  const rule = String(ruleDomain || '').trim().toLowerCase();
  if (!sender || !rule) return false;
  return sender === rule || sender.endsWith(`.${rule}`);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function toDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function toIsoDate(value) {
  if (!value) return null;
  const d = toDateOrNull(value);
  if (!d) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeBillingPeriod(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('month')) return 'Monthly';
  if (raw.startsWith('quarter')) return 'Quarterly';
  if (raw.startsWith('annual') || raw.startsWith('year')) return 'Annual';
  return '';
}

function applyAdditionalServicesToSoftware(sw, services = []) {
  if (!sw) return;
  const rows = Array.isArray(services) ? services : [];
  if (!rows.length) return;
  if (!Array.isArray(sw.services)) sw.services = [];
  for (const svc of rows) {
    const name = String(svc?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const existing = sw.services.find((row) => String(row?.name || '').trim().toLowerCase() === key);
    const qtyRaw = Number(svc?.purchasedLicenses);
    const priceRaw = Number(svc?.licensePricePerUserMonth);
    const annualRaw = Number(svc?.annualCost);
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? Math.round(qtyRaw) : null;
    const annual = Number.isFinite(annualRaw) && annualRaw > 0 ? Number(annualRaw) : null;
    let price = Number.isFinite(priceRaw) && priceRaw > 0 ? Number(priceRaw) : null;
    if (!(Number.isFinite(price) && price > 0) && Number.isFinite(annual) && annual > 0 && Number.isFinite(qty) && qty > 0) {
      price = Number((annual / (qty * 12)).toFixed(2));
    }
    if (!(Number.isFinite(price) && price > 0) && Number.isFinite(annual) && annual > 0) {
      price = Number((annual / 12).toFixed(2));
    }
    const plan = String(svc?.plan || '').trim();
    const renewal = String(svc?.renewalPeriod || '').trim();
    if (existing) {
      if (Number.isFinite(qty) && qty > 0) existing.purchasedLicenses = qty;
      if (Number.isFinite(price) && price > 0) existing.licensePricePerUserMonth = price;
      if (Number.isFinite(annual) && annual > 0) existing.annualCost = annual;
      if (plan) existing.plan = plan;
      if (['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''].includes(renewal)) {
        existing.renewalPeriod = renewal;
      }
      if (!existing.status) existing.status = 'Active';
    } else {
      sw.services.push({
        name,
        plan,
        annualCost: Number.isFinite(annual) && annual > 0 ? annual : 0,
        licensePricePerUserMonth: Number.isFinite(price) && price > 0 ? price : 0,
        purchasedLicenses: Number.isFinite(qty) && qty > 0 ? qty : 0,
        usedLicenses: 0,
        renewalPeriod: ['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''].includes(renewal) ? renewal : '',
        status: 'Active',
      });
    }
  }
}

async function canReviewMailInvoices(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const permissions = req.user.permissions || await getResolvedPermissions(req.user.role);
    req.user.permissions = permissions;
    if (permissions?.manageSoftware || permissions?.manageIntegrations) return next();
    return res.status(403).json({ error: 'Insufficient permissions' });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}

function isValidObjectIdText(value = '') {
  return /^[a-f\d]{24}$/i.test(String(value || '').trim());
}

function safeInlineFilename(value = '', fallback = 'invoice.pdf') {
  const raw = String(value || '').trim() || String(fallback || '').trim() || 'invoice.pdf';
  const sanitized = raw
    .replace(/[\r\n]/g, ' ')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim();
  return sanitized.slice(0, 180) || 'invoice.pdf';
}

async function persistAttachmentBlobForEvent(event, buffer) {
  if (!event || !buffer || !(buffer instanceof Buffer) || !buffer.length) return null;

  const blob = await MailInvoiceBlob.findOneAndUpdate(
    { eventId: event._id },
    {
      $set: {
        provider: 'gmail',
        messageId: String(event.messageId || '').trim(),
        attachmentHashSha256: String(event.attachmentHashSha256 || '').trim(),
        filename: String(event.attachmentName || '').trim(),
        mimeType: String(event.attachmentMime || '').trim() || 'application/pdf',
        size: Number(buffer.length || 0),
        data: buffer,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const blobId = String(blob?._id || '').trim();
  if (blobId && (String(event.storageProvider || '') !== 'mongo_blob' || String(event.storageKey || '') !== blobId)) {
    event.storageProvider = 'mongo_blob';
    event.storageKey = blobId;
    await event.save();
  }

  return blob;
}

async function ensureEventAttachmentBlob(event, opts = {}) {
  if (!event) return null;
  const prefetchedBuffer = opts?.buffer;
  const eventId = String(event._id || '').trim();
  if (!eventId) return null;

  const storageKey = String(event.storageKey || '').trim();
  if (String(event.storageProvider || '').trim() === 'mongo_blob' && isValidObjectIdText(storageKey)) {
    const existingByKey = await MailInvoiceBlob.findById(storageKey);
    if (existingByKey?.data?.length) return existingByKey;
  }

  const existingByEvent = await MailInvoiceBlob.findOne({ eventId: event._id });
  if (existingByEvent?.data?.length) {
    const blobId = String(existingByEvent._id || '').trim();
    if (blobId && (String(event.storageProvider || '') !== 'mongo_blob' || String(event.storageKey || '') !== blobId)) {
      event.storageProvider = 'mongo_blob';
      event.storageKey = blobId;
      await event.save();
    }
    return existingByEvent;
  }

  if (prefetchedBuffer && prefetchedBuffer instanceof Buffer && prefetchedBuffer.length) {
    return persistAttachmentBlobForEvent(event, prefetchedBuffer);
  }

  if (!String(event.gmailAttachmentId || '').trim()) return null;
  const attachmentBytes = Number(event.attachmentSize || 0);
  if (Number.isFinite(attachmentBytes) && attachmentBytes > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Attachment exceeds max size (${MAX_ATTACHMENT_BYTES} bytes)`);
  }

  const { accessToken, mailbox } = await getGmailContext(event.mailbox || '');
  const fetched = await fetchAttachmentBuffer({
    accessToken,
    mailbox,
    messageId: event.messageId,
    attachmentId: event.gmailAttachmentId,
    maxBytes: MAX_ATTACHMENT_BYTES,
  });
  return persistAttachmentBlobForEvent(event, fetched);
}

function scoreRule(rule = {}, context = {}) {
  const senderEmail = String(context.senderEmail || '').toLowerCase();
  const senderDomain = String(context.senderDomain || '').toLowerCase();
  const subject = String(context.subject || '').toLowerCase();
  const filename = String(context.filename || '').toLowerCase();
  const docText = String(context.docText || '').toLowerCase();

  const senderEmails = toLowerList(rule.senderEmails);
  const senderDomains = toLowerList(rule.senderDomains);
  const subjectKeywords = toLowerList(rule.subjectKeywords);
  const excludeKeywords = toLowerList(rule.excludeKeywords);
  const filenamePatterns = toLowerList(rule.filenamePatterns);
  const vendorKeywordsInDoc = toLowerList(rule.vendorKeywordsInDoc);
  const bodyKeywords = toLowerList(rule.bodyKeywords);

  const haystack = `${subject}\n${filename}`;

  if (excludeKeywords.some(keyword => haystack.includes(keyword))) {
    return { score: 0, reasons: ['exclude_keyword'], blocked: true };
  }

  let score = 0;
  const reasons = [];

  if (senderEmails.includes(senderEmail)) {
    score += 55;
    reasons.push('senderEmail');
  }

  if (senderDomains.some((d) => domainMatches(senderDomain, d))) {
    score += 40;
    reasons.push('senderDomain');
  }

  let subjectHits = 0;
  for (const keyword of subjectKeywords) {
    if (!keyword) continue;
    if (subject.includes(keyword)) subjectHits += 1;
  }
  if (subjectHits > 0) {
    score += Math.min(24, subjectHits * 8);
    reasons.push('subjectKeyword');
  }

  let filenameHits = 0;
  for (const keyword of filenamePatterns) {
    if (!keyword) continue;
    if (filename.includes(keyword)) filenameHits += 1;
  }
  if (filenameHits > 0) {
    score += Math.min(16, filenameHits * 8);
    reasons.push('filenamePattern');
  }

  let vendorHits = 0;
  for (const keyword of vendorKeywordsInDoc) {
    if (!keyword) continue;
    if (docText && docText.includes(keyword)) vendorHits += 1;
  }
  if (vendorHits > 0) {
    score += Math.min(18, vendorHits * 6);
    reasons.push('vendorKeywordInDoc');
  }

  // Body keywords — match invoice-type words (invoice, receipt, payment, cost, etc.) in email body + attachment text
  let bodyHits = 0;
  const bodyHaystack = docText || '';
  for (const keyword of bodyKeywords) {
    if (!keyword) continue;
    if (bodyHaystack.includes(keyword)) bodyHits += 1;
  }
  if (bodyHits > 0) {
    score += Math.min(22, bodyHits * 7);
    reasons.push('bodyKeyword');
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
    blocked: false,
  };
}

function pickBestRule(rules = [], context = {}) {
  let best = null;
  for (const rule of rules) {
    const result = scoreRule(rule, context);
    if (result.blocked) continue;
    if (!best || result.score > best.score || (result.score === best.score && Number(rule.priority || 0) > Number(best.rule.priority || 0))) {
      best = { rule, ...result };
    }
  }
  return best;
}

function hasSenderMatchReason(reasons = []) {
  const list = Array.isArray(reasons) ? reasons : [];
  return list.includes('senderEmail') || list.includes('senderDomain');
}

function senderPriorityScore(score = 0, reasons = []) {
  const base = Number.isFinite(Number(score)) ? Number(score) : 0;
  if (hasSenderMatchReason(reasons)) return Math.max(base, SENDER_PRIORITY_SCORE);
  return base;
}

function isTrustedSenderRuleMatch(best = null) {
  if (!best || !best.rule?.softwareId) return false;
  return hasSenderMatchReason(best.reasons);
}

function sanitizeGmailFromTerm(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.includes('@')) {
    return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw) ? raw : '';
  }
  const domain = raw.replace(/^@+/, '').replace(/^\*\./, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain) ? domain : '';
}

function buildSenderBoostedQuery(baseQuery = '', rules = [], options = {}) {
  const base = String(baseQuery || '').trim();
  const strict = options && Object.prototype.hasOwnProperty.call(options, 'strict')
    ? Boolean(options.strict)
    : true;
  const senderTerms = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const emails = Array.isArray(rule?.senderEmails) ? rule.senderEmails : [];
    const domains = Array.isArray(rule?.senderDomains) ? rule.senderDomains : [];
    for (const email of emails) {
      const clean = sanitizeGmailFromTerm(email);
      if (!clean) continue;
      const term = `from:${clean}`;
      if (!senderTerms.includes(term)) senderTerms.push(term);
    }
    for (const domain of domains) {
      const clean = sanitizeGmailFromTerm(domain);
      if (!clean) continue;
      const term = `from:${clean}`;
      if (!senderTerms.includes(term)) senderTerms.push(term);
    }
  }

  if (!senderTerms.length) return base;
  const capped = senderTerms.slice(0, 40);
  const senderClause = `(${capped.join(' OR ')})`;
  if (!base) return senderClause;
  return strict ? `(${base}) AND ${senderClause}` : `(${base}) OR ${senderClause}`;
}

function normalizeSoftwareNameKey(name = '') {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function softwareNameTokens(name = '') {
  return normalizeSoftwareNameKey(name)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !['app', 'software', 'suite', 'tool', 'the', 'and', 'for'].includes(token));
}

function getFallbackHint(name = '') {
  const key = normalizeSoftwareNameKey(name);
  if (!key) return null;
  if (SOFTWARE_FALLBACK_HINTS[key]) return SOFTWARE_FALLBACK_HINTS[key];
  if (key.includes('microsoft 365') || key.includes('office 365')) return SOFTWARE_FALLBACK_HINTS['microsoft 365'];
  if (key.includes('adobe')) return SOFTWARE_FALLBACK_HINTS.adobe;
  if (key.includes('figma')) return SOFTWARE_FALLBACK_HINTS.figma;
  if (key.includes('miro')) return SOFTWARE_FALLBACK_HINTS.miro;
  return null;
}

function softwareFallbackCandidate(sw = {}) {
  const softwareId = String(sw?._id || sw?.id || '').trim();
  const name = String(sw?.name || '').trim();
  if (!softwareId || !name) return null;

  const key = normalizeSoftwareNameKey(name);
  const hint = getFallbackHint(name) || { aliases: [], domains: [] };
  const aliases = [...new Set([key, ...toLowerList(hint.aliases), name.toLowerCase()])].filter(Boolean);
  const tokens = [...new Set(softwareNameTokens(name))];
  const domains = [...new Set(toLowerList(hint.domains))];
  return {
    softwareId,
    softwareName: name,
    aliases,
    tokens,
    domains,
  };
}

function scoreSoftwareFallbackCandidate(candidate = {}, context = {}) {
  const senderDomain = String(context.senderDomain || '').trim().toLowerCase();
  const subject = String(context.subject || '').toLowerCase();
  const filename = String(context.filename || '').toLowerCase();
  const docText = String(context.docText || '').toLowerCase();
  const shortText = `${subject}\n${filename}`;

  let score = 0;
  const reasons = [];

  if (senderDomain && candidate.domains.some((d) => domainMatches(senderDomain, d))) {
    score += 70;
    reasons.push('fallback_sender_domain');
  }

  const aliasHits = candidate.aliases.filter((alias) => alias && shortText.includes(alias));
  if (aliasHits.length) {
    score += Math.min(22 + (aliasHits.length * 10), 42);
    reasons.push('fallback_alias_subject_or_filename');
  }

  const aliasDocHits = candidate.aliases.filter((alias) => alias && docText && docText.includes(alias));
  if (aliasDocHits.length) {
    score += Math.min(18 + (aliasDocHits.length * 8), 34);
    reasons.push('fallback_alias_doc_text');
  }

  const tokenHits = candidate.tokens.filter((token) => token && (shortText.includes(token) || (docText && docText.includes(token))));
  if (tokenHits.length >= 2) {
    score += Math.min(10 + (tokenHits.length * 3), 18);
    reasons.push('fallback_name_tokens');
  }

  if (!reasons.length) return { score: 0, reasons: [] };
  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

function pickBestSoftwareFallback(softwareRows = [], context = {}) {
  let best = null;
  for (const sw of softwareRows) {
    const candidate = softwareFallbackCandidate(sw);
    if (!candidate) continue;
    const result = scoreSoftwareFallbackCandidate(candidate, context);
    if (!result.score) continue;
    if (!best || result.score > best.score) {
      best = {
        softwareId: candidate.softwareId,
        softwareName: candidate.softwareName,
        score: result.score,
        reasons: result.reasons,
      };
    }
  }
  return best;
}

function isPdfAttachmentMeta(filename = '', mimeType = '') {
  const file = String(filename || '').trim().toLowerCase();
  const mime = String(mimeType || '').trim().toLowerCase();
  return mime === 'application/pdf' || file.endsWith('.pdf');
}

function hasInvoiceSignal({ subject = '', filename = '', docText = '' } = {}) {
  const shortDoc = String(docText || '').slice(0, 8000);
  const haystack = `${String(subject || '')}\n${String(filename || '')}\n${shortDoc}`;
  return INVOICE_SIGNAL_RE.test(haystack);
}

function sanitizeHttpUrl(url = '') {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString();
  } catch {
    return '';
  }
}

function selectPreferredInvoiceUrl(links = [], context = {}) {
  const normalized = [];
  for (const raw of Array.isArray(links) ? links : []) {
    const clean = sanitizeHttpUrl(raw);
    if (!clean) continue;
    if (!normalized.includes(clean)) normalized.push(clean);
    if (normalized.length >= 50) break;
  }
  if (!normalized.length) return { preferred: '', links: [] };

  const senderDomain = String(context?.senderDomain || '').trim().toLowerCase();
  const scored = normalized.map((url) => {
    let score = 0;
    const low = url.toLowerCase();
    let host = '';
    try { host = String(new URL(url).hostname || '').toLowerCase(); } catch {}
    if (/\.pdf(?:$|[?#])/.test(low)) score += 35;
    if (/\b(invoice|billing|receipt|statement|bill|payment|order)\b/.test(low)) score += 28;
    if (/\b(login|signin|auth)\b/.test(low)) score -= 8;
    if (senderDomain && domainMatches(host, senderDomain)) score += 18;
    return { url, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored[0] || null;
  // Avoid surfacing generic vendor/login links as "View Invoice".
  // Require a minimum invoice-like score before promoting a preferred URL.
  const MIN_PREFERRED_INVOICE_URL_SCORE = 28;
  return {
    preferred: top && Number(top.score) >= MIN_PREFERRED_INVOICE_URL_SCORE ? top.url : '',
    links: normalized.slice(0, 20),
  };
}

function normalizeCurrencyCode(text = '') {
  const t = String(text || '').toUpperCase();
  if (!t) return '';
  if (/\bUSD\b/.test(t) || t.includes('$')) return 'USD';
  if (/\bEUR\b/.test(t) || t.includes('€')) return 'EUR';
  if (/\bGBP\b/.test(t) || t.includes('£')) return 'GBP';
  if (/\bINR\b/.test(t) || t.includes('₹')) return 'INR';
  return '';
}

function parseMoneyNumber(raw = '') {
  if (!raw) return null;
  const normalized = String(raw || '')
    .replace(/[^\d,.\-]/g, '')
    .replace(/,(?=\d{3}\b)/g, '');
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(2));
}

function parseIsoDateFromText(raw = '') {
  const text = String(raw || '').trim();
  if (!text) return null;
  const d = new Date(text);
  if (Number.isNaN(d.getTime())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function extractInvoiceDetailsFromEmailText({ subject = '', bodyText = '' } = {}) {
  const subjectText = String(subject || '').trim();
  const body = String(bodyText || '').trim();
  const haystack = `${subjectText}\n${body}`.trim();
  const lower = haystack.toLowerCase();

  const warnings = ['Extracted from email content (no PDF attachment found)'];
  const currency = normalizeCurrencyCode(haystack) || 'USD';

  // Look for amount near invoice-related keywords first (most reliable)
  const totalMatch = haystack.match(/(?:invoice\s+total|total\s+due|amount\s+due|amount\s+charged|charge|billed|payment\s+of)[^\d$€£₹\-]{0,24}([$€£₹]?\s*\d[\d,]*\.\d{2})/i);

  // Fallback: look for currency-prefixed amounts with decimals (e.g. $119.95, €50.00)
  const currencyPrefixedMatches = [...haystack.matchAll(/([$€£₹]\s*\d[\d,]*\.\d{2})/g)]
    .map((m) => parseMoneyNumber(m[1]))
    .filter((n) => Number.isFinite(n) && n > 0 && n < 1000000); // sanity: < $1M

  let amount = parseMoneyNumber(totalMatch?.[1] || '');

  // Only use fallback if primary match failed, and cap at reasonable invoice amounts
  if (!Number.isFinite(amount) || amount <= 0) {
    amount = currencyPrefixedMatches.length ? Math.max(...currencyPrefixedMatches) : null;
  }

  // Sanity check: email-body amounts above $500k are almost certainly garbage (phone numbers, IDs)
  const EMAIL_BODY_MAX_AMOUNT = 500000;
  if (Number.isFinite(amount) && amount > EMAIL_BODY_MAX_AMOUNT) {
    warnings.push(`Extracted amount ${amount} exceeds sanity threshold (${EMAIL_BODY_MAX_AMOUNT}); discarded`);
    amount = null;
  }

  const qtyMatch = haystack.match(/(?:qty|quantity|licenses?|licence|seats?|users?)\s*[:\-]?\s*(\d{1,6})/i);
  const qty = Number(qtyMatch?.[1]);
  const licenseQuantity = Number.isFinite(qty) && qty > 0 && qty < 100000 ? Math.round(qty) : null;

  const unitMatch = haystack.match(/(?:unit\s*price|price\s*per\s*(?:user|seat|license|licen[cs]e)|\/\s*(?:user|seat|license|licen[cs]e))(?:\s*[:\-])?\s*([$€£₹]?\s*\d[\d,]*\.\d{2})/i);
  const unitPrice = parseMoneyNumber(unitMatch?.[1] || '');

  // Date range extraction — support multiple formats:
  //   "Jan 24, 2026 - Feb 23, 2026"  |  "01/24/2026 - 02/23/2026"  |  "2026-01-24 to 2026-02-23"
  const datePatterns = [
    // "Month DD, YYYY - Month DD, YYYY"
    /([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\s*(?:-|–|—|to)\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
    // "MM/DD/YYYY - MM/DD/YYYY" or "DD/MM/YYYY - DD/MM/YYYY"
    /(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:-|–|—|to)\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
    // "YYYY-MM-DD to YYYY-MM-DD"
    /(\d{4}-\d{2}-\d{2})\s*(?:-|–|—|to)\s*(\d{4}-\d{2}-\d{2})/i,
    // "billing period: Month DD - Month DD, YYYY" (shared year)
    /(?:billing\s*period|period|service\s*date)[^\n]{0,10}?([A-Za-z]{3,9}\s+\d{1,2})\s*(?:-|–|—|to)\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
  ];
  let fromToMatch = null;
  for (const pat of datePatterns) {
    fromToMatch = haystack.match(pat);
    if (fromToMatch) break;
  }
  const periodFrom = parseIsoDateFromText(fromToMatch?.[1] || '');
  const periodTo = parseIsoDateFromText(fromToMatch?.[2] || '');

  let billingPeriod = '';
  if (/\bmonthly|month\b/i.test(lower)) billingPeriod = 'Monthly';
  else if (/\bquarterly|quarter\b/i.test(lower)) billingPeriod = 'Quarterly';
  else if (/\bannual|annually|yearly|year\b/i.test(lower)) billingPeriod = 'Annual';

  // Extract subscription plan — only from body, avoid grabbing company names
  const planMatch = body.match(/(?:plan|subscription|product)\s*[:\-]\s*([^\n]{3,60})/i);
  let subscriptionPlan = String(planMatch?.[1] || '').trim();
  // Reject plan names that look like company/account names from subject lines
  if (/\b(?:is available|invoice for|thank|order)\b/i.test(subscriptionPlan)) {
    subscriptionPlan = '';
  }

  // Determine confidence based on what was extracted
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const hasPeriod = !!(periodFrom || periodTo || billingPeriod);
  const hasQty = Number.isFinite(licenseQuantity) && licenseQuantity > 0;
  const confidence = (hasAmount && hasPeriod) ? 'medium'
    : (hasAmount || (hasQty && hasPeriod)) ? 'low'
    : 'very-low';

  return {
    amount: Number.isFinite(Number(amount)) ? Number(amount) : null,
    currency: String(currency || '').trim(),
    billingPeriod,
    periodFrom: periodFrom ? toDateOrNull(periodFrom) : null,
    periodTo: periodTo ? toDateOrNull(periodTo) : null,
    licenseQuantity: Number.isFinite(Number(licenseQuantity)) ? Number(licenseQuantity) : null,
    licenseUnitPrice: Number.isFinite(Number(unitPrice)) ? Number(unitPrice) : null,
    subscriptionPlan,
    parseConfidence: confidence,
    source: 'email-body-heuristic',
    warnings,
    needsReview: true,
  };
}

function eventDto(doc = {}) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(o._id || ''),
    provider: o.provider,
    mailbox: o.mailbox,
    messageId: o.messageId,
    threadId: o.threadId,
    from: o.from,
    fromEmail: o.fromEmail,
    fromDomain: o.fromDomain,
    subject: o.subject,
    receivedAt: o.receivedAt,
    attachmentName: o.attachmentName,
    attachmentMime: o.attachmentMime,
    attachmentSize: o.attachmentSize,
    attachmentHashSha256: o.attachmentHashSha256,
    invoiceLinks: Array.isArray(o.invoiceLinks) ? o.invoiceLinks : [],
    preferredInvoiceUrl: String(o.preferredInvoiceUrl || '').trim(),
    storedFileAvailable: (String(o.storageProvider || '').trim() === 'mongo_blob' && Boolean(String(o.storageKey || '').trim()))
      || Boolean(String(o.gmailAttachmentId || '').trim()),
    matchedSoftwareId: o.matchedSoftwareId || null,
    matchedRuleId: o.matchedRuleId || null,
    matchScore: o.matchScore || 0,
    matchReasons: Array.isArray(o.matchReasons) ? o.matchReasons : [],
    status: o.status,
    reviewRequired: !!o.reviewRequired,
    error: o.error || '',
    softwareInvoiceId: o.softwareInvoiceId || null,
    extraction: o.extraction || {},
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

function ruleDto(doc = {}) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  return {
    id: String(o._id || ''),
    softwareId: o.softwareId,
    softwareCsvId: o.softwareCsvId,
    softwareName: o.softwareName,
    enabled: !!o.enabled,
    senderDomains: o.senderDomains || [],
    senderEmails: o.senderEmails || [],
    subjectKeywords: o.subjectKeywords || [],
    excludeKeywords: o.excludeKeywords || [],
    filenamePatterns: o.filenamePatterns || [],
    vendorKeywordsInDoc: o.vendorKeywordsInDoc || [],
    bodyKeywords: o.bodyKeywords || [],
    priority: o.priority,
    autoAttachThreshold: o.autoAttachThreshold,
    reviewThreshold: o.reviewThreshold,
    createdBy: o.createdBy || '',
    updatedBy: o.updatedBy || '',
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
  };
}

async function runInvoiceExtraction(dataUrl = '', context = {}, requestId = '') {
  if (typeof extractInvoiceFields === 'function') {
    try {
      return await extractInvoiceFields(dataUrl, context, requestId);
    } catch (err) {
      // fall through
    }
  }

  const fallback = await parseInvoicePDF(dataUrl, { context });
  return {
    ...fallback,
    source: 'js-fallback',
    warnings: [...(fallback?.warnings || []), 'Extracted by JS fallback in invoice-mail flow'],
  };
}

function hasExtractedInvoiceData(parsed = {}) {
  const amount = Number(parsed?.amount);
  const qty = Number(parsed?.licenseQuantity);
  const unit = Number(parsed?.licenseUnitPrice);
  const plan = String(parsed?.subscriptionPlan || '').trim();
  const billing = normalizeBillingPeriod(parsed?.billingPeriod || parsed?.renewalPeriod || '');
  const fromIso = toIsoDate(parsed?.periodFrom);
  const toIso = toIsoDate(parsed?.periodTo);

  return Number.isFinite(amount)
    || Number.isFinite(qty)
    || Number.isFinite(unit)
    || Boolean(plan)
    || Boolean(billing)
    || Boolean(fromIso)
    || Boolean(toIso);
}

function normalizeExtractedLineItems(lineItems = []) {
  return (Array.isArray(lineItems) ? lineItems : [])
    .map((li) => {
      const quantity = Number(li?.quantity);
      const unitPrice = Number(li?.unitPrice);
      const subtotal = Number(li?.subtotal);
      const taxes = Number(li?.taxes);
      const total = Number(li?.total);
      const kindRaw = String(li?.kind || '').trim().toLowerCase();
      const kind = ['charge', 'credit', 'usage', 'other'].includes(kindRaw) ? kindRaw : 'other';
      return {
        name: String(li?.name || '').trim(),
        quantity: Number.isFinite(quantity) ? Math.round(quantity) : null,
        unitPrice: Number.isFinite(unitPrice) ? Number(Number(unitPrice).toFixed(2)) : null,
        subtotal: Number.isFinite(subtotal) ? Number(Number(subtotal).toFixed(2)) : null,
        taxes: Number.isFinite(taxes) ? Number(Number(taxes).toFixed(2)) : null,
        total: Number.isFinite(total) ? Number(Number(total).toFixed(2)) : null,
        kind,
      };
    })
    .filter((li) => li.name || Number.isFinite(Number(li.total)));
}

async function attachEventToSoftware({ event, softwareId, note = '', requestId = '' }) {
  const targetSoftwareId = String(softwareId || event?.matchedSoftwareId || '').trim();
  if (!targetSoftwareId) {
    throw new Error('softwareId is required to attach invoice');
  }

  const sw = await Software.findById(targetSoftwareId);
  if (!sw) throw new Error('Software not found');

  let attachment = null;
  let parsed = null;

  const hasBinaryAttachment = Boolean(String(event?.gmailAttachmentId || '').trim())
    || (String(event?.storageProvider || '').trim() === 'mongo_blob' && Boolean(String(event?.storageKey || '').trim()));

  if (hasBinaryAttachment) {
    const blob = await ensureEventAttachmentBlob(event);
    if (!blob?.data?.length) {
      throw new Error('Invoice attachment is unavailable in mailbox storage');
    }

    const buffer = Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data);
    attachment = createAttachmentRecord({
      messageId: event.messageId,
      part: {
        filename: blob.filename || event.attachmentName,
        mimeType: blob.mimeType || event.attachmentMime,
        size: Number(blob.size || event.attachmentSize || buffer.length),
        attachmentId: event.gmailAttachmentId,
      },
      buffer,
    });

    parsed = await runInvoiceExtraction(attachment.dataUrl, {
      expectedLicenseQuantity: sw.purchasedLicenses,
      defaultCurrency: sw.currency || 'USD',
    }, requestId);
  } else {
    const extraction = event?.extraction || {};
    const periodFromIsoLocal = toIsoDate(extraction?.periodFrom);
    const periodToIsoLocal = toIsoDate(extraction?.periodTo);
    attachment = {
      filename: String(event?.attachmentName || '').trim() || `invoice-email-${String(event?.messageId || 'mail')}.txt`,
      mimeType: String(event?.attachmentMime || '').trim() || 'text/plain',
      size: Number(event?.attachmentSize || 0),
      attachmentId: '',
      hashSha256: String(event?.attachmentHashSha256 || '').trim() || crypto.createHash('sha256').update(`${event.messageId || ''}:${event.subject || ''}`).digest('hex'),
      dataUrl: '',
    };
    parsed = {
      amount: Number.isFinite(Number(extraction?.amount)) ? Number(extraction.amount) : null,
      currency: String(extraction?.currency || 'USD').trim() || 'USD',
      billingPeriod: normalizeBillingPeriod(extraction?.billingPeriod || extraction?.renewalPeriod || ''),
      periodFrom: periodFromIsoLocal,
      periodTo: periodToIsoLocal,
      licenseQuantity: Number.isFinite(Number(extraction?.licenseQuantity)) ? Math.round(Number(extraction.licenseQuantity)) : null,
      licenseUnitPrice: Number.isFinite(Number(extraction?.licenseUnitPrice))
        ? Number(Number(extraction.licenseUnitPrice).toFixed(2))
        : null,
      subscriptionPlan: String(extraction?.subscriptionPlan || '').trim(),
      confidence: ['high', 'medium', 'low'].includes(String(extraction?.parseConfidence || '').trim().toLowerCase())
        ? String(extraction.parseConfidence).trim().toLowerCase()
        : 'low',
      source: String(extraction?.source || 'email-body-heuristic').trim(),
      warnings: Array.isArray(extraction?.warnings) && extraction.warnings.length
        ? extraction.warnings.slice(0, 20).map(String)
        : ['No PDF attachment found; used email invoice details'],
      needsReview: true,
      lineItems: normalizeExtractedLineItems(extraction?.lineItems || []),
    };
  }

  if (!hasExtractedInvoiceData(parsed)) {
    event.status = 'failed';
    event.reviewRequired = true;
    event.error = 'Invoice extraction returned no usable fields; not attached to software';
    event.extraction = {
      source: String(parsed?.source || '').trim(),
      parseConfidence: ['high', 'medium', 'low'].includes(String(parsed?.confidence || '')) ? String(parsed.confidence) : '',
      warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.slice(0, 20).map(String) : [],
      needsReview: true,
    };
    await event.save();
    throw new Error('Invoice extraction failed: no usable fields found');
  }

  const periodFromIso = toIsoDate(parsed?.periodFrom);
  const periodToIso = toIsoDate(parsed?.periodTo);
  const billingPeriod = normalizeBillingPeriod(parsed?.billingPeriod || parsed?.renewalPeriod || '');
  const lineItems = normalizeExtractedLineItems(parsed?.lineItems || []);
  const derivedAdditionalServices = deriveAdditionalServicesFromLineItems({
    lineItems,
    billingPeriod,
    currentMainPlan: String(sw.subscriptionPlan || '').trim(),
    parsedMainPlan: String(parsed?.subscriptionPlan || '').trim(),
  });
  applyAdditionalServicesToSoftware(sw, derivedAdditionalServices);

  // Update top-level software fields from latest invoice extraction
  // Only update plan from high/medium confidence sources; skip email-body-heuristic low-confidence plans
  const parsedPlan = String(parsed?.subscriptionPlan || '').trim();
  const parsedConfidence = String(parsed?.confidence || parsed?.parseConfidence || '').toLowerCase();
  const isLowConfidencePlan = parsedConfidence === 'low' || parsedConfidence === 'very-low'
    || String(parsed?.source || '').includes('email-body');
  if (parsedPlan && (!isLowConfidencePlan || !sw.subscriptionPlan)) {
    sw.subscriptionPlan = parsedPlan;
  }

  // Count total licenses: base + additional users from line items
  const seatLineItems = (lineItems || []).filter((li) => {
    const name = String(li?.name || '').toLowerCase();
    const qty = Number(li?.quantity);
    return Number.isFinite(qty) && qty > 0 && /\b(user|seat|license)\b/i.test(name);
  });
  const totalSeatsFromLineItems = seatLineItems.reduce((sum, li) => sum + Math.round(Number(li.quantity)), 0);

  const parsedQty = Number(parsed?.licenseQuantity);
  if (totalSeatsFromLineItems > 0) {
    sw.purchasedLicenses = totalSeatsFromLineItems;
  } else if (Number.isFinite(parsedQty) && parsedQty > 0) {
    sw.purchasedLicenses = Math.round(parsedQty);
  }

  const parsedUnit = Number(parsed?.licenseUnitPrice);
  if (Number.isFinite(parsedUnit) && parsedUnit > 0) sw.licensePricePerUserMonth = Number(parsedUnit.toFixed(2));

  const parsedCurrency = String(parsed?.currency || '').trim().toUpperCase();
  if (parsedCurrency) sw.currency = parsedCurrency;

  if (billingPeriod) sw.renewalPeriod = billingPeriod;

  // Recalculate BASE annual cost (excludes add-on services).
  // Strategy: annualise the invoice total, then subtract add-on service costs.
  const invoiceAmount = Number(parsed?.amount);
  if (Number.isFinite(invoiceAmount) && invoiceAmount > 0 && billingPeriod) {
    let totalAnnualised;
    if (billingPeriod === 'Monthly') totalAnnualised = invoiceAmount * 12;
    else if (billingPeriod === 'Quarterly') totalAnnualised = invoiceAmount * 4;
    else totalAnnualised = invoiceAmount;

    const addonTotal = (derivedAdditionalServices || []).reduce(
      (sum, s) => sum + Number(s.annualCost || 0), 0,
    );
    const baseCost = Math.max(totalAnnualised - addonTotal, 0);
    sw.annualCost = Number(baseCost.toFixed(2));
  } else {
    // Fallback: use base seat count × unit price (exclude additional-user seats)
    const baseSeatItems = seatLineItems.filter((li) => {
      const name = String(li?.name || '').toLowerCase();
      return !/\b(additional|extra|added)\b/.test(name);
    });
    const baseSeats = baseSeatItems.reduce((sum, li) => sum + Math.round(Number(li.quantity)), 0);
    const effectiveQty = baseSeats > 0 ? baseSeats : Number(sw.purchasedLicenses || 0);
    const effectivePrice = Number(sw.licensePricePerUserMonth || 0);
    if (effectiveQty > 0 && effectivePrice > 0) {
      sw.annualCost = Number((effectiveQty * effectivePrice * 12).toFixed(2));
    }
  }

  // Deduplicate: skip if an invoice from the same Gmail message is already attached
  const srcMsgId = String(event.messageId || '').trim();
  const alreadyAttached = srcMsgId && sw.invoices.some(
    (inv) => String(inv.sourceMessageId || '').trim() === srcMsgId,
  );
  if (alreadyAttached) {
    console.log(`[SoftDocs] Skipping duplicate invoice attach — messageId ${srcMsgId} already on software ${sw.name}`);
  } else {
    sw.invoices.push({
      filename: attachment.filename,
      data: attachment.dataUrl,
      mimeType: attachment.mimeType,
      amount: Number.isFinite(Number(parsed?.amount)) ? Number(parsed.amount) : 0,
      currency: String(parsed?.currency || 'USD').trim() || 'USD',
      note: String(note || '').trim() || `Imported from Gmail (${event.mailbox || 'mailbox'})`,
      licenseQuantity: Number.isFinite(Number(parsed?.licenseQuantity)) ? Math.round(Number(parsed.licenseQuantity)) : null,
      licenseUnitPrice: Number.isFinite(Number(parsed?.licenseUnitPrice)) ? Number(Number(parsed.licenseUnitPrice).toFixed(2)) : null,
      subscriptionPlan: String(parsed?.subscriptionPlan || '').trim(),
      billingPeriod,
      periodFrom: periodFromIso ? toDateOrNull(periodFromIso) : null,
      periodTo: periodToIso ? toDateOrNull(periodToIso) : null,
      parseConfidence: ['high', 'medium', 'low'].includes(String(parsed?.confidence || '')) ? String(parsed.confidence) : '',
      source: 'email_ingestion',
      sourceProvider: event.provider || 'gmail',
      sourceMessageId: srcMsgId,
      attachmentHashSha256: attachment.hashSha256 || event.attachmentHashSha256 || '',
      reviewRequired: Boolean(parsed?.needsReview || event.reviewRequired),
      matchScore: Number.isFinite(Number(event.matchScore)) ? Math.round(Number(event.matchScore)) : 0,
      extractionSource: String(parsed?.source || '').trim(),
      lineItems,
    });
  }

  await sw.save();

  const inv = sw.invoices[sw.invoices.length - 1];

  event.matchedSoftwareId = sw._id;
  event.softwareInvoiceId = inv._id;
  event.status = parsed ? 'parsed' : 'attached';
  event.reviewRequired = Boolean(parsed?.needsReview || false);
  event.error = '';
  event.extraction = {
    amount: Number.isFinite(Number(parsed?.amount)) ? Number(parsed.amount) : null,
    currency: String(parsed?.currency || '').trim(),
    billingPeriod,
    periodFrom: periodFromIso ? toDateOrNull(periodFromIso) : null,
    periodTo: periodToIso ? toDateOrNull(periodToIso) : null,
    licenseQuantity: Number.isFinite(Number(parsed?.licenseQuantity)) ? Math.round(Number(parsed.licenseQuantity)) : null,
    licenseUnitPrice: Number.isFinite(Number(parsed?.licenseUnitPrice)) ? Number(Number(parsed.licenseUnitPrice).toFixed(2)) : null,
    subscriptionPlan: String(parsed?.subscriptionPlan || '').trim(),
    parseConfidence: ['high', 'medium', 'low'].includes(String(parsed?.confidence || '')) ? String(parsed.confidence) : '',
    source: String(parsed?.source || '').trim(),
    warnings: Array.isArray(parsed?.warnings) ? parsed.warnings.slice(0, 20).map(String) : [],
    needsReview: Boolean(parsed?.needsReview || false),
    lineItems,
  };
  await event.save();

  await writeLog({
    eventType: 'software_updated',
    entityType: 'software',
    entityId: sw._id.toString(),
    entityLabel: sw.name,
    summary: `Invoice imported from Gmail: ${attachment.filename} -> ${sw.name}`,
  });

  return {
    softwareId: sw._id,
    softwareInvoiceId: inv._id,
    status: event.status,
    reviewRequired: event.reviewRequired,
    // Return updated services so callers can sync the Add-on Services table immediately.
    services: (sw.services || []).map(svc => ({
      id: svc._id ? svc._id.toString() : undefined,
      name: svc.name,
      plan: svc.plan || '',
      annualCost: svc.annualCost || 0,
      licensePricePerUserMonth: svc.licensePricePerUserMonth || 0,
      purchasedLicenses: svc.purchasedLicenses || 0,
      usedLicenses: svc.usedLicenses || 0,
      renewalPeriod: svc.renewalPeriod || '',
      status: svc.status || 'Active',
    })),
  };
}

// ── Rules management ──────────────────────────────────────────────────────────
router.get('/rules', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const list = await MailInvoiceRule.find().sort({ priority: -1, createdAt: -1 });
    res.json(list.map(ruleDto));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/rules', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const softwareId = String(req.body?.softwareId || '').trim();
    if (!softwareId) return res.status(400).json({ error: 'softwareId is required' });

    const sw = await Software.findById(softwareId).select('csvId name').lean();
    if (!sw) return res.status(404).json({ error: 'Software not found' });

    const rule = await MailInvoiceRule.create({
      softwareId: sw._id,
      softwareCsvId: sw.csvId,
      softwareName: sw.name,
      enabled: req.body?.enabled !== false,
      senderDomains: req.body?.senderDomains || [],
      senderEmails: req.body?.senderEmails || [],
      subjectKeywords: req.body?.subjectKeywords || [],
      excludeKeywords: req.body?.excludeKeywords || [],
      filenamePatterns: req.body?.filenamePatterns || [],
      vendorKeywordsInDoc: req.body?.vendorKeywordsInDoc || [],
      bodyKeywords: req.body?.bodyKeywords || [],
      priority: clampInt(req.body?.priority, 100, 0, 10000),
      autoAttachThreshold: clampInt(req.body?.autoAttachThreshold, 80, 0, 100),
      reviewThreshold: clampInt(req.body?.reviewThreshold, 50, 0, 100),
      createdBy: req.user?.email || req.user?.name || '',
      updatedBy: req.user?.email || req.user?.name || '',
    });

    res.status(201).json(ruleDto(rule));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/rules/:id', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const rule = await MailInvoiceRule.findById(req.params.id);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });

    if (req.body?.softwareId) {
      const sw = await Software.findById(req.body.softwareId).select('csvId name').lean();
      if (!sw) return res.status(404).json({ error: 'Software not found' });
      rule.softwareId = sw._id;
      rule.softwareCsvId = sw.csvId;
      rule.softwareName = sw.name;
    }

    const fields = [
      'enabled',
      'senderDomains',
      'senderEmails',
      'subjectKeywords',
      'excludeKeywords',
      'filenamePatterns',
      'vendorKeywordsInDoc',
      'bodyKeywords',
      'priority',
      'autoAttachThreshold',
      'reviewThreshold',
    ];

    for (const key of fields) {
      if (req.body?.[key] === undefined) continue;
      if (['priority', 'autoAttachThreshold', 'reviewThreshold'].includes(key)) {
        rule[key] = clampInt(req.body[key], Number(rule[key] || 0), key === 'priority' ? 0 : 0, key === 'priority' ? 10000 : 100);
      } else {
        rule[key] = req.body[key];
      }
    }

    rule.updatedBy = req.user?.email || req.user?.name || '';
    await rule.save();

    res.json(ruleDto(rule));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.delete('/rules/:id', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const deleted = await MailInvoiceRule.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Sync mailbox invoices ─────────────────────────────────────────────────────
router.post('/sync', requireAuth, canManageIntegrations, async (req, res) => {
  try {
    const provider = String(req.body?.provider || 'gmail').trim().toLowerCase();
    if (provider !== 'gmail') return res.status(400).json({ error: 'Only gmail provider is supported' });

    const mailbox = String(req.body?.mailbox || '').trim();
    const since = String(req.body?.since || '').trim();
    const limit = clampInt(req.body?.limit, 50, 1, 100);
    const dryRun = Boolean(req.body?.dryRun);
    const strictSenderRules = req.body?.strictSenderRules !== false;

    const rules = await MailInvoiceRule.find({ enabled: true }).sort({ priority: -1, createdAt: -1 }).lean();
    const softwareRows = await Software.find({ status: { $ne: 'Inactive' } }).select('_id name csvId status').lean();
    const { accessToken, mailbox: resolvedMailbox, baseQuery } = await getGmailContext(mailbox);
    const hasAnySenderRule = rules.some((rule) => {
      const hasEmails = Array.isArray(rule?.senderEmails) && rule.senderEmails.some((v) => String(v || '').trim());
      const hasDomains = Array.isArray(rule?.senderDomains) && rule.senderDomains.some((v) => String(v || '').trim());
      return hasEmails || hasDomains;
    });
    const enforceSenderRules = strictSenderRules && hasAnySenderRule;
    const effectiveQuery = buildSenderBoostedQuery(baseQuery, rules, { strict: enforceSenderRules });

    const listed = await listGmailMessages({
      accessToken,
      mailbox: resolvedMailbox,
      query: effectiveQuery,
      limit,
      since,
    });

    const summary = {
      ok: true,
      provider: 'gmail',
      mailbox: resolvedMailbox,
      scanned: 0,
      created: 0,
      duplicates: 0,
      skipped: 0,
      autoMatched: 0,
      reviewRequired: 0,
      failed: 0,
      skippedBySender: 0,
      skippedZeroScore: 0,
      purgedZeroScore: 0,
      strictSenderRules: enforceSenderRules,
      query: listed.query,
      batchId: `gmail_${Date.now()}`,
    };

    // Keep queue clean: remove stale 0-score, un-attached events.
    try {
      const purge = await MailInvoiceEvent.deleteMany({
        matchScore: { $lte: 0 },
        softwareInvoiceId: null,
        status: { $in: ['queued', 'downloaded', 'matched', 'review_required', 'failed', 'ignored'] },
      });
      summary.purgedZeroScore = Number(purge?.deletedCount || 0);
    } catch {
      // best-effort cleanup
    }

    console.log(`[SoftDocs Sync] Starting — ${listed.messages.length} messages to process, strict=${enforceSenderRules}`);
    for (const msg of listed.messages) {
      let envelope;
      try {
        const msgStart = Date.now();
        const message = await Promise.race([
          getGmailMessage({ accessToken, mailbox: resolvedMailbox, messageId: msg.id }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Gmail message fetch timeout (30s)')), 30000)),
        ]);
        envelope = parseMessageEnvelope(message);
        console.log(`[SoftDocs Sync] Message ${msg.id} fetched in ${Date.now() - msgStart}ms — from: ${envelope.fromEmail}, subject: ${(envelope.subject || '').slice(0, 60)}`);
      } catch (err) {
        console.error(`[SoftDocs Sync] Failed to fetch message ${msg.id}: ${err.message}`);
        summary.failed += 1;
        continue;
      }

      const emailBodyText = String(envelope.bodyText || '').trim();
      const invoiceLinkSelection = selectPreferredInvoiceUrl(envelope.links || [], {
        senderDomain: envelope.fromDomain,
      });
      const hasBodyInvoiceSignal = hasInvoiceSignal({
        subject: envelope.subject,
        filename: '',
        docText: emailBodyText,
      });
      const bodyExtraction = extractInvoiceDetailsFromEmailText({
        subject: envelope.subject,
        bodyText: emailBodyText,
      });
      const hasBodyExtractionData = hasExtractedInvoiceData(bodyExtraction);
      const senderOnlyBest = pickBestRule(rules, {
        senderEmail: envelope.fromEmail,
        senderDomain: envelope.fromDomain,
        subject: '',
        filename: '',
        docText: '',
      });
      const trustedSenderOnly = isTrustedSenderRuleMatch(senderOnlyBest);
      if (enforceSenderRules && !trustedSenderOnly) {
        summary.skippedBySender += 1;
        summary.skipped += 1;
        continue;
      }
      const processableParts = (Array.isArray(envelope.parts) ? envelope.parts : [])
        .filter((part) => ALLOW_IMAGE_ATTACHMENTS || isPdfAttachmentMeta(part?.filename, part?.mimeType));
      const preferredParts = processableParts.filter((part) => isPdfAttachmentMeta(part?.filename, part?.mimeType));
      const candidateParts = preferredParts.length ? preferredParts : processableParts;

      // When strict sender rules are enforced, we already validated the sender above.
      // For non-strict mode, still require invoice signal or trusted sender.
      if (!enforceSenderRules && !candidateParts.length && !hasBodyInvoiceSignal && !trustedSenderOnly) {
        summary.skipped += 1;
        continue;
      }
      summary.scanned += 1;

      if (!candidateParts.length) {
        try {
          const bodyHash = crypto.createHash('sha256')
            .update(`${envelope.messageId || ''}\n${envelope.subject || ''}\n${emailBodyText.slice(0, 100000)}`)
            .digest('hex');
          const existing = await MailInvoiceEvent.findOne({
            provider: 'gmail',
            messageId: envelope.messageId,
            attachmentHashSha256: bodyHash,
          }).lean();
          if (existing) {
            summary.duplicates += 1;
            continue;
          }

          const best = pickBestRule(rules, {
            senderEmail: envelope.fromEmail,
            senderDomain: envelope.fromDomain,
            subject: envelope.subject,
            filename: '',
            docText: emailBodyText,
          });
          const fallbackBest = (!best || !best.rule?.softwareId) ? pickBestSoftwareFallback(softwareRows, {
            senderDomain: envelope.fromDomain,
            subject: envelope.subject,
            filename: '',
            docText: emailBodyText,
          }) : null;

          let matchedSoftwareId = null;
          let matchedRuleId = null;
          let matchScore = 0;
          let matchReasons = ['no_pdf_attachment'];
          if (best) {
            matchedSoftwareId = best.rule.softwareId || null;
            matchedRuleId = best.rule._id || null;
            matchScore = senderPriorityScore(best.score, best.reasons);
            matchReasons = [...new Set([...(Array.isArray(best.reasons) ? best.reasons : []), 'no_pdf_attachment'])];
          } else if (fallbackBest && fallbackBest.softwareId) {
            matchedSoftwareId = fallbackBest.softwareId;
            matchScore = Number(fallbackBest.score || 0);
            matchReasons = [...new Set([...(Array.isArray(fallbackBest.reasons) ? fallbackBest.reasons : []), 'no_pdf_attachment'])];
          }

          // Do not create queue rows for 0%/unmatched events.
          if (!matchedSoftwareId || !Number.isFinite(Number(matchScore)) || Number(matchScore) <= 0) {
            summary.skipped += 1;
            summary.skippedZeroScore += 1;
            continue;
          }

          const emailBodyEvent = await MailInvoiceEvent.create({
            provider: 'gmail',
            mailbox: resolvedMailbox,
            messageId: envelope.messageId,
            threadId: envelope.threadId,
            historyId: envelope.historyId,
            from: envelope.from,
            fromEmail: envelope.fromEmail,
            fromDomain: envelope.fromDomain,
            subject: envelope.subject,
            receivedAt: envelope.receivedAt,
            attachmentName: '(email-body)',
            attachmentMime: 'text/html',
            attachmentSize: Buffer.byteLength(emailBodyText || '', 'utf8'),
            attachmentHashSha256: bodyHash,
            gmailAttachmentId: '',
            invoiceLinks: invoiceLinkSelection.links,
            preferredInvoiceUrl: invoiceLinkSelection.preferred,
            matchedSoftwareId,
            matchedRuleId,
            matchScore,
            matchReasons,
            status: 'review_required',
            reviewRequired: true,
            error: 'No PDF attachment found; extracted invoice clues from email body',
            extraction: bodyExtraction,
          });

          // Store email body as blob so "View Invoice" works from DB
          try {
            const bodyBuffer = Buffer.from(emailBodyText || '', 'utf8');
            if (bodyBuffer.length) {
              await persistAttachmentBlobForEvent(emailBodyEvent, bodyBuffer);
            }
          } catch (storageErr) {
            // best-effort — event still created, just no stored file
          }

          summary.created += 1;
          summary.reviewRequired += 1;
        } catch (err) {
          summary.failed += 1;
        }
        continue;
      }

      for (const part of candidateParts) {
        try {
          const partSize = Number(part?.size || 0);
          if (Number.isFinite(partSize) && partSize > MAX_ATTACHMENT_BYTES) {
            summary.failed += 1;
            continue;
          }
          const buffer = await fetchAttachmentBuffer({
            accessToken,
            mailbox: resolvedMailbox,
            messageId: envelope.messageId,
            attachmentId: part.attachmentId,
            maxBytes: MAX_ATTACHMENT_BYTES,
          });
          const attachment = createAttachmentRecord({
            messageId: envelope.messageId,
            part,
            buffer,
          });
          const docText = await Promise.race([
            extractAttachmentTextForMatching({ buffer, mimeType: attachment.mimeType, filename: attachment.filename }),
            new Promise((resolve) => setTimeout(() => resolve(''), 45000)),
          ]);
          const combinedDocText = [docText, emailBodyText].filter(Boolean).join('\n');
          const best = pickBestRule(rules, {
            senderEmail: envelope.fromEmail,
            senderDomain: envelope.fromDomain,
            subject: envelope.subject,
            filename: attachment.filename,
            docText: combinedDocText,
          });
          const trustedSenderForPart = isTrustedSenderRuleMatch(best);
          // When strict sender rules: sender already validated at top of loop, process all attachments.
          // Otherwise: require invoice signal or trusted sender match for each part.
          if (!enforceSenderRules && !hasInvoiceSignal({ subject: envelope.subject, filename: attachment.filename, docText: combinedDocText }) && !trustedSenderForPart) {
            summary.skipped += 1;
            continue;
          }

          const existing = await MailInvoiceEvent.findOne({
            provider: 'gmail',
            messageId: envelope.messageId,
            attachmentHashSha256: attachment.hashSha256,
          }).lean();
          if (existing) {
            summary.duplicates += 1;
            continue;
          }
          const fallbackBest = (!best || !best.rule?.softwareId) ? pickBestSoftwareFallback(softwareRows, {
            senderDomain: envelope.fromDomain,
            subject: envelope.subject,
            filename: attachment.filename,
            docText: combinedDocText,
          }) : null;

          let matchedSoftwareId = null;
          let matchedRuleId = null;
          let matchScore = 0;
          let matchReasons = [];
          let status = 'review_required';
          let reviewRequired = true;
          let shouldAutoAttach = false;

          if (best) {
            matchedSoftwareId = best.rule.softwareId || null;
            matchedRuleId = best.rule._id || null;
            matchScore = senderPriorityScore(best.score, best.reasons);
            matchReasons = Array.isArray(best.reasons) ? best.reasons : [];

            const autoAttachThreshold = clampInt(best.rule.autoAttachThreshold, 80, 0, 100);
            const reviewThreshold = clampInt(best.rule.reviewThreshold, 50, 0, 100);

            if (matchScore >= autoAttachThreshold && matchedSoftwareId) {
              shouldAutoAttach = true;
              status = dryRun ? 'matched' : 'matched';
              reviewRequired = false;
              summary.autoMatched += 1;
            } else if (matchScore >= reviewThreshold) {
              status = 'review_required';
              reviewRequired = true;
              summary.reviewRequired += 1;
            } else {
              status = 'review_required';
              reviewRequired = true;
              summary.reviewRequired += 1;
            }
          } else if (fallbackBest && fallbackBest.softwareId) {
            matchedSoftwareId = fallbackBest.softwareId;
            matchedRuleId = null;
            matchScore = Number(fallbackBest.score || 0);
            matchReasons = Array.isArray(fallbackBest.reasons) ? fallbackBest.reasons : [];

            if (matchScore >= FALLBACK_AUTO_ATTACH_THRESHOLD && matchedSoftwareId) {
              shouldAutoAttach = true;
              status = dryRun ? 'matched' : 'matched';
              reviewRequired = false;
              summary.autoMatched += 1;
            } else if (matchScore >= FALLBACK_REVIEW_THRESHOLD) {
              status = 'review_required';
              reviewRequired = true;
              summary.reviewRequired += 1;
            } else {
              matchedSoftwareId = null;
              matchScore = 0;
              matchReasons = [];
              summary.reviewRequired += 1;
            }
          } else {
            summary.reviewRequired += 1;
          }

          // Do not persist 0%/unmatched events in queue.
          if (!matchedSoftwareId || !Number.isFinite(Number(matchScore)) || Number(matchScore) <= 0) {
            summary.skipped += 1;
            summary.skippedZeroScore += 1;
            continue;
          }

          const event = await MailInvoiceEvent.create({
            provider: 'gmail',
            mailbox: resolvedMailbox,
            messageId: envelope.messageId,
            threadId: envelope.threadId,
            historyId: envelope.historyId,
            from: envelope.from,
            fromEmail: envelope.fromEmail,
            fromDomain: envelope.fromDomain,
            subject: envelope.subject,
            receivedAt: envelope.receivedAt,
            attachmentName: attachment.filename,
            attachmentMime: attachment.mimeType,
            attachmentSize: attachment.size,
            attachmentHashSha256: attachment.hashSha256,
            gmailAttachmentId: attachment.attachmentId,
            invoiceLinks: invoiceLinkSelection.links,
            preferredInvoiceUrl: invoiceLinkSelection.preferred,
            matchedSoftwareId,
            matchedRuleId,
            matchScore,
            matchReasons,
            status,
            reviewRequired,
            error: '',
            extraction: hasBodyExtractionData ? bodyExtraction : undefined,
          });

          try {
            await ensureEventAttachmentBlob(event, { buffer });
          } catch (storageErr) {
            event.status = 'failed';
            event.reviewRequired = true;
            event.error = `Attachment downloaded but DB storage failed: ${storageErr.message}`;
            await event.save();
            summary.failed += 1;
            continue;
          }

          summary.created += 1;

          if (!dryRun && shouldAutoAttach && matchedSoftwareId) {
            try {
              await attachEventToSoftware({
                event,
                softwareId: matchedSoftwareId,
                note: 'Imported automatically from Gmail sync',
                requestId: req.requestId || '',
              });
            } catch (err) {
              summary.failed += 1;
              event.status = 'failed';
              event.reviewRequired = true;
              event.error = err.message;
              await event.save();
            }
          }
        } catch (err) {
          summary.failed += 1;
        }
      }
    }

    await IntegrationSettings.updateOne(
      { provider: 'gmail' },
      { $set: { gmailLastSyncedAt: new Date() } },
      { upsert: true }
    );

    console.log(`[SoftDocs Sync] Done — scanned: ${summary.scanned}, created: ${summary.created}, duplicates: ${summary.duplicates}, skipped: ${summary.skipped}, failed: ${summary.failed}`);
    res.json(summary);
  } catch (e) {
    console.error(`[SoftDocs Sync] Fatal error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// ── Review queue ───────────────────────────────────────────────────────────────
router.get('/review', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));
    const statusRaw = String(req.query.status || 'review_required').trim().toLowerCase();
    const softwareId = String(req.query.softwareId || '').trim();

    const filter = {};
    if (statusRaw && statusRaw !== 'all') {
      if (statusRaw.includes(',')) {
        const statuses = statusRaw.split(',').map(s => String(s || '').trim()).filter(Boolean);
        if (statuses.length) filter.status = { $in: statuses };
      } else {
        filter.status = statusRaw;
      }
    }
    if (req.query.mailbox) filter.mailbox = String(req.query.mailbox).trim().toLowerCase();
    const includeZeroScore = String(req.query.includeZeroScore || '').trim().toLowerCase();
    const allowZeroScore = includeZeroScore === '1' || includeZeroScore === 'true' || includeZeroScore === 'yes';
    if (!allowZeroScore) filter.matchScore = { $gt: 0 };
    if (softwareId) {
      if (softwareId === 'unmatched') {
        filter.$or = [{ matchedSoftwareId: null }, { matchedSoftwareId: { $exists: false } }];
      } else if (!/^[a-f\d]{24}$/i.test(softwareId)) {
        return res.status(400).json({ error: 'softwareId must be a valid ObjectId or unmatched' });
      } else {
        filter.matchedSoftwareId = softwareId;
      }
    }

    const [rows, total] = await Promise.all([
      MailInvoiceEvent.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      MailInvoiceEvent.countDocuments(filter),
    ]);

    res.json({
      total,
      page,
      limit,
      events: rows.map(eventDto),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events/:eventId', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const event = await MailInvoiceEvent.findById(req.params.eventId).lean();
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(eventDto(event));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/events/:eventId/file', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const event = await MailInvoiceEvent.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const blob = await ensureEventAttachmentBlob(event);
    if (!blob?.data?.length) {
      return res.status(404).json({ error: 'No stored invoice file for this event' });
    }

    const filename = safeInlineFilename(blob.filename || event.attachmentName || `invoice-${event.messageId || event._id}.pdf`);
    const mimeType = String(blob.mimeType || event.attachmentMime || 'application/pdf').trim() || 'application/pdf';
    const size = Number(blob.size || blob.data.length || 0);

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    if (Number.isFinite(size) && size > 0) res.setHeader('Content-Length', String(size));
    return res.end(Buffer.isBuffer(blob.data) ? blob.data : Buffer.from(blob.data));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:eventId/attach', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const event = await MailInvoiceEvent.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    if (event.status === 'ignored') return res.status(400).json({ error: 'Ignored event cannot be attached' });

    const softwareId = String(req.body?.softwareId || event.matchedSoftwareId || '').trim();
    if (!softwareId) return res.status(400).json({ error: 'softwareId is required' });

    const outcome = await attachEventToSoftware({
      event,
      softwareId,
      note: String(req.body?.note || '').trim(),
      requestId: req.requestId || '',
    });

    res.json({
      ok: true,
      eventId: String(event._id),
      softwareId: String(outcome.softwareId),
      softwareInvoiceId: String(outcome.softwareInvoiceId),
      status: outcome.status,
      reviewRequired: !!outcome.reviewRequired,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.post('/:eventId/ignore', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const event = await MailInvoiceEvent.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    event.status = 'ignored';
    event.reviewRequired = false;
    event.error = String(req.body?.reason || '').trim() || 'Ignored manually';
    await event.save();
    res.json({ ok: true, event: eventDto(event) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:eventId/retry', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const event = await MailInvoiceEvent.findById(req.params.eventId);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const step = String(req.body?.step || 'attach').trim().toLowerCase();
    if (!['attach', 'extract'].includes(step)) {
      return res.status(400).json({ error: 'step must be attach or extract' });
    }

    const softwareId = String(req.body?.softwareId || event.matchedSoftwareId || '').trim();
    if (!softwareId) return res.status(400).json({ error: 'softwareId is required for retry' });

    const outcome = await attachEventToSoftware({
      event,
      softwareId,
      note: String(req.body?.note || '').trim() || 'Reprocessed from mail invoice queue',
      requestId: req.requestId || '',
    });

    res.json({ ok: true, eventId: String(event._id), status: outcome.status, softwareInvoiceId: String(outcome.softwareInvoiceId) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.get('/stats', requireAuth, canReviewMailInvoices, async (req, res) => {
  try {
    const from = req.query.from ? toDateOrNull(req.query.from) : null;
    const to = req.query.to ? toDateOrNull(req.query.to) : null;

    const filter = {};
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = from;
      if (to) filter.createdAt.$lte = to;
    }

    const [total, attached, parsed, reviewRequired, failed, duplicatesByHash] = await Promise.all([
      MailInvoiceEvent.countDocuments(filter),
      MailInvoiceEvent.countDocuments({ ...filter, status: 'attached' }),
      MailInvoiceEvent.countDocuments({ ...filter, status: 'parsed' }),
      MailInvoiceEvent.countDocuments({ ...filter, reviewRequired: true }),
      MailInvoiceEvent.countDocuments({ ...filter, status: 'failed' }),
      MailInvoiceEvent.aggregate([
        { $match: filter },
        { $group: { _id: '$attachmentHashSha256', c: { $sum: 1 } } },
        { $match: { _id: { $ne: '' }, c: { $gt: 1 } } },
        { $count: 'count' },
      ]),
    ]);

    res.json({
      total,
      attached,
      parsed,
      reviewRequired,
      failed,
      duplicates: Number(duplicatesByHash?.[0]?.count || 0),
      from: from || null,
      to: to || null,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
