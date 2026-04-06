/**
 * routes/software.routes.js — Software Inventory
 *
 * GET    /api/software
 * GET    /api/software/budget
 * POST   /api/software
 * PUT    /api/software/:id
 * DELETE /api/software/:id
 */
const router = require('express').Router();
const { Software } = require('../db');
const { requireAuth, canWriteSoftware } = require('../middleware/auth');
const { writeLog } = require('../services/log.service');
const { parseInvoicePDF } = require('../utils/invoice-parser');
const pdf = require('pdf-parse');

const INVOICE_PARSER_URL = String(process.env.INVOICE_PARSER_URL || '').trim().replace(/\/$/, '');
const INVOICE_PARSER_TIMEOUT_MS = Math.max(1000, Number(process.env.INVOICE_PARSER_TIMEOUT_MS || 30000));
const REGION_EPSILON = 0.001;
const MAX_LICENSE_QTY = Math.max(1, Number(process.env.MAX_LICENSE_QTY || 10000));
const CLAUDE_API_KEY = String(process.env.CLAUDE_API_KEY || '').trim();
const CLAUDE_MODEL = String(process.env.CLAUDE_MODEL || 'claude-3-5-sonnet-latest').trim();
const CLAUDE_API_URL = String(process.env.CLAUDE_API_URL || 'https://api.anthropic.com/v1/messages').trim();
const CLAUDE_TIMEOUT_MS = Math.max(1000, Number(process.env.CLAUDE_TIMEOUT_MS || 30000));
const CLAUDE_MAX_INPUT_CHARS = Math.max(2000, Number(process.env.CLAUDE_MAX_INPUT_CHARS || 20000));
const CLAUDE_FALLBACK_ENABLED = String(process.env.CLAUDE_FALLBACK_ENABLED || 'true').toLowerCase() !== 'false';

// Helper: total cost for a software entry including active add-on services
const svcCost   = x => ((x.services || []).filter(s => s.status !== 'Inactive').reduce((ss, sv) => ss + (sv.annualCost || 0), 0));
const totalCost = x => (x.annualCost || 0) + svcCost(x);

// Normalise a Software doc to a plain object
function fmtSw(s) {
  const o = s.toObject ? s.toObject() : { ...s };
  o.id = o._id.toString();
  delete o._id;
  delete o.__v;
  return o;
}

function diffSoftware(before, after) {
  const fields = [
    'csvId', 'name', 'deploymentType', 'provisioningMethod', 'connectorType', 'supportsDeprovision',
    'provisioningNotes', 'renewalPeriod', 'department', 'purpose',
    'licensePricePerUserMonth', 'annualCost', 'subscriptionPlan', 'purchasedLicenses',
    'usedLicenses', 'owner', 'admins', 'billedTo', 'status', 'siteUSA', 'siteCAN', 'siteIND',
  ];
  const changes = [];
  for (const field of fields) {
    const oldValue = before?.[field];
    const newValue = after?.[field];
    if (JSON.stringify(oldValue ?? '') === JSON.stringify(newValue ?? '')) continue;
    changes.push({
      field,
      oldValue: oldValue === undefined || oldValue === '' ? '—' : String(oldValue),
      newValue: newValue === undefined || newValue === '' ? '—' : String(newValue),
    });
  }

  if (JSON.stringify(before?.services || []) !== JSON.stringify(after?.services || [])) {
    changes.push({
      field: 'services',
      oldValue: `Count: ${(before?.services || []).length}`,
      newValue: `Count: ${(after?.services || []).length}`,
    });
  }

  return changes;
}

function normalizeBillingPeriod(value = '') {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('month')) return 'Monthly';
  if (raw.startsWith('quarter')) return 'Quarterly';
  if (raw.startsWith('annual') || raw.startsWith('year')) return 'Annual';
  if (raw === 'freeware') return 'Freeware';
  if (raw === 'pay-as-you-go' || raw === 'payg') return 'Pay-as-you-go';
  return '';
}

function normalizeIsoDate(value = '') {
  const v = String(value || '').trim();
  if (!v) return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || (dt.getUTCMonth() + 1) !== mo || dt.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isClaudeReady() {
  return Boolean(CLAUDE_FALLBACK_ENABLED && CLAUDE_API_KEY && CLAUDE_MODEL);
}

function looksLikeDateQuantity(n) {
  if (!Number.isFinite(n)) return false;
  if (Number.isInteger(n) && n >= 1900 && n <= 2100) return true;
  const s = String(Math.round(Math.abs(n)));
  if (s.length === 6) {
    const maybeYear = Number(s.slice(2));
    if (maybeYear >= 1900 && maybeYear <= 2100) return true;
  }
  if (s.length === 8) {
    const yyyy = Number(s.slice(0, 4));
    const mm = Number(s.slice(4, 6));
    const dd = Number(s.slice(6, 8));
    if (yyyy >= 1900 && yyyy <= 2100 && mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) return true;
  }
  return false;
}

function normalizeLineItem(raw = {}) {
  const qty = Number(raw.quantity);
  const unitPrice = Number(raw.unitPrice);
  const subtotal = Number(raw.subtotal);
  const taxes = Number(raw.taxes);
  const total = Number(raw.total);
  const kindRaw = String(raw.kind || '').trim().toLowerCase();
  const kind = ['charge', 'credit', 'usage', 'other'].includes(kindRaw) ? kindRaw : 'other';
  const safeQty = Number.isFinite(qty) ? Math.round(qty) : null;
  return {
    name: String(raw.name || '').trim(),
    quantity: Number.isFinite(safeQty) && safeQty > 0 && safeQty <= MAX_LICENSE_QTY && !looksLikeDateQuantity(safeQty) ? safeQty : null,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : null,
    subtotal: Number.isFinite(subtotal) ? subtotal : null,
    taxes: Number.isFinite(taxes) ? taxes : null,
    total: Number.isFinite(total) ? total : null,
    kind,
  };
}

function isProratedLineName(name = '') {
  const low = String(name || '').toLowerCase();
  return /\bpro[\s-]?rat(?:ed|ion)\b/.test(low)
    || /\btrue[-\s]?up\b/.test(low)
    || /\bpartial\s+(?:month|period)\b/.test(low)
    || /\badjustment\b/.test(low)
    || /\bcredit\b/.test(low);
}

function isSeatLikeLineName(name = '') {
  const low = String(name || '').toLowerCase();
  return /\b(seat|license|licensed|user|member|editor|viewer|full\s*seat|dev\s*seat)\b/.test(low);
}

function normalizeServiceLabel(name = '') {
  return String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\-:•\s]+|[\-:•\s]+$/g, '');
}

const SERVICE_NAME_STOPWORDS = new Set([
  'additional', 'add', 'addon', 'users', 'user', 'seats', 'seat', 'license', 'licenses', 'licensed',
  'member', 'members', 'qty', 'quantity', 'unit', 'price', 'plan', 'subscription',
  'monthly', 'annual', 'quarterly', 'month', 'yearly', 'prorated', 'proration',
  'credit', 'adjustment', 'true', 'up', 'term', 'period', 'sku',
]);

function isSeatModifierLineName(name = '') {
  const low = String(name || '').toLowerCase();
  return /\badditional\s+(?:user|users|seat|seats|license|licenses)\b/.test(low)
    || /\bextra\s+(?:user|users|seat|seats|license|licenses)\b/.test(low)
    || /\bincluded\s+(?:user|users|seat|seats|license|licenses)\b/.test(low)
    || /\badd[-\s]?on\b/.test(low);
}

function serviceNameTokens(name = '') {
  return normalizeServiceLabel(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((token) => !SERVICE_NAME_STOPWORDS.has(token));
}

function serviceSimilarityKey(name = '') {
  const tokens = serviceNameTokens(name);
  if (tokens.length) return tokens.join('|');
  return normalizeServiceLabel(name).toLowerCase();
}

function isLikelySameServiceName(a = '', b = '') {
  const left = normalizeServiceLabel(a).toLowerCase();
  const right = normalizeServiceLabel(b).toLowerCase();
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.includes(right) || right.includes(left)) return true;

  const aSet = new Set(serviceNameTokens(left));
  const bSet = new Set(serviceNameTokens(right));
  if (!aSet.size || !bSet.size) return false;

  let intersection = 0;
  for (const token of aSet) {
    if (bSet.has(token)) intersection += 1;
  }
  const minSize = Math.min(aSet.size, bSet.size);
  return intersection >= 2 && intersection === minSize;
}

function summarizeSeatLines(lineItems = []) {
  const rows = Array.isArray(lineItems) ? lineItems : [];
  const positiveChargeRows = rows
    .filter((li) => String(li?.kind || '').toLowerCase() !== 'credit')
    .map((li, idx) => ({ ...li, _idx: idx }));
  const hasProratedRows = positiveChargeRows.some((li) => isProratedLineName(li?.name));
  const seatLike = positiveChargeRows.filter((li) => {
    const name = normalizeServiceLabel(li?.name || '');
    const qty = Number(li?.quantity);
    const unit = Number(li?.unitPrice);
    const hasNumericPair = Number.isFinite(qty) && qty > 0 && Number.isFinite(unit) && unit > 0;
    if (isProratedLineName(name)) return false;
    return isSeatLikeLineName(name) || hasNumericPair;
  });

  const enriched = seatLike.map((li) => ({
    _idx: li._idx,
    name: normalizeServiceLabel(li?.name || '') || `Service ${li._idx + 1}`,
    quantity: Number.isFinite(Number(li?.quantity)) ? Math.round(Number(li.quantity)) : null,
    unitPrice: Number.isFinite(Number(li?.unitPrice)) ? Number(li.unitPrice) : null,
    subtotal: Number.isFinite(Number(li?.subtotal)) ? Number(li.subtotal) : null,
    total: Number.isFinite(Number(li?.total)) ? Number(li.total) : null,
  }));

  const primaryLine = [...enriched].sort((a, b) => {
    const aModifier = isSeatModifierLineName(a?.name) ? 1 : 0;
    const bModifier = isSeatModifierLineName(b?.name) ? 1 : 0;
    if (aModifier !== bModifier) return aModifier - bModifier;
    const aq = Number(a?.quantity || 0);
    const bq = Number(b?.quantity || 0);
    if (bq !== aq) return bq - aq;
    const at = Number(a?.total || a?.subtotal || 0);
    const bt = Number(b?.total || b?.subtotal || 0);
    if (bt !== at) return bt - at;
    return a._idx - b._idx;
  })[0] || null;

  const additionalCandidates = enriched
    .filter((li) => primaryLine && li._idx !== primaryLine._idx)
    .filter((li) => !isLikelySameServiceName(li?.name, primaryLine?.name));
  const additionalByKey = new Map();
  for (const li of additionalCandidates) {
    const key = serviceSimilarityKey(li?.name);
    if (!key) continue;
    const existing = additionalByKey.get(key);
    if (!existing) {
      additionalByKey.set(key, li);
      continue;
    }
    const liQty = Number(li?.quantity || 0);
    const exQty = Number(existing?.quantity || 0);
    const liAmt = Number(li?.total || li?.subtotal || 0);
    const exAmt = Number(existing?.total || existing?.subtotal || 0);
    if (liQty > exQty || (liQty === exQty && liAmt > exAmt)) {
      additionalByKey.set(key, li);
    }
  }
  const additionalLines = [...additionalByKey.values()];

  const quantities = enriched
    .map((li) => Number(li?.quantity))
    .filter((v) => Number.isFinite(v) && v > 0 && v <= MAX_LICENSE_QTY)
    .map((v) => Math.round(v));
  const totalQuantity = quantities.reduce((sum, v) => sum + v, 0);

  const weightedNumerator = enriched.reduce((sum, li) => {
    const q = Number(li?.quantity);
    const u = Number(li?.unitPrice);
    if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(u) || u <= 0) return sum;
    return sum + (q * u);
  }, 0);
  const weightedDenominator = enriched.reduce((sum, li) => {
    const q = Number(li?.quantity);
    return Number.isFinite(q) && q > 0 ? sum + q : sum;
  }, 0);
  const blendedUnitPrice = weightedDenominator > 0 ? (weightedNumerator / weightedDenominator) : null;

  const distinctUnits = [...new Set(enriched
    .map((li) => Number(li?.unitPrice))
    .filter((v) => Number.isFinite(v) && v > 0)
    .map((v) => Number(v.toFixed(4))))];

  return {
    primaryLine,
    primaryQuantity: Number.isFinite(Number(primaryLine?.quantity)) ? Math.round(Number(primaryLine.quantity)) : 0,
    primaryUnitPrice: Number.isFinite(Number(primaryLine?.unitPrice)) ? Number(primaryLine.unitPrice) : null,
    primaryName: primaryLine?.name || '',
    additionalLines,
    quantities,
    totalQuantity,
    lineCount: enriched.length,
    blendedUnitPrice: Number.isFinite(blendedUnitPrice) && blendedUnitPrice > 0 ? blendedUnitPrice : null,
    hasMixedUnitPrices: distinctUnits.length > 1,
    hasProratedRows,
  };
}

function cleanServiceName(name = '') {
  return String(name || '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\-:•\s]+|[\-:•\s]+$/g, '')
    .trim();
}

function serviceGroupKey(name = '') {
  return cleanServiceName(name)
    .toLowerCase()
    .replace(/\bincludes?\b/g, ' ')
    // Strip transactional suffixes so "Product - License change +2" groups with "Product"
    .replace(/\s*[-–]\s*(license\s+change|prorat|prepay|monthly\s+subscription\s+charges?)\b.*/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .map((v) => v.trim())
    .filter(Boolean)
    .filter((v) => !/^\d+$/.test(v))
    .join('|');
}

function isDiscountLikeLineItem(li = {}) {
  const kind = String(li?.kind || '').trim().toLowerCase();
  const name = String(li?.name || '').toLowerCase();
  const total = Number(li?.total);
  const subtotal = Number(li?.subtotal);
  if (kind === 'credit') return true;
  if ((Number.isFinite(total) && total < 0) || (Number.isFinite(subtotal) && subtotal < 0)) return true;
  if (/\b(discount|coupon|promo|promotion|rebate|waiver|write[-\s]?off|credit|adjustment)\b/.test(name)) return true;
  // Filter out transactional/prorated line items — these are billing adjustments, not actual services
  if (/\b(prorat|charges?\s+(?:before|after)\s+license|license\s+change|one[-\s]?time|refund)\b/i.test(name)) return true;
  return false;
}

function annualizeAmountForPeriod(amount = 0, period = '') {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const p = normalizeBillingPeriod(period);
  if (p === 'Monthly') return n * 12;
  if (p === 'Quarterly') return n * 4;
  return n;
}

function deriveAdditionalServicesFromLineItems({
  lineItems = [],
  billingPeriod = '',
  currentMainPlan = '',
  parsedMainPlan = '',
} = {}) {
  const rows = Array.isArray(lineItems) ? lineItems : [];
  if (!rows.length) return [];

  const groups = new Map();
  const ordered = [];
  for (const li of rows) {
    const name = cleanServiceName(li?.name || '');
    if (!name) continue;
    if (isDiscountLikeLineItem(li)) continue;

    let amount = Number(li?.total);
    if (!Number.isFinite(amount)) amount = Number(li?.subtotal);
    if (!Number.isFinite(amount)) {
      const q = Number(li?.quantity);
      const u = Number(li?.unitPrice);
      if (Number.isFinite(q) && Number.isFinite(u)) amount = q * u;
    }
    if (!(Number.isFinite(amount) && amount > 0)) continue;

    const key = serviceGroupKey(name) || name.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { key, name, amount: 0, rows: [] });
      ordered.push(key);
    }
    const entry = groups.get(key);
    entry.amount += amount;
    entry.rows.push(li);
    if (name.length < entry.name.length) entry.name = name;
  }

  let entries = ordered.map((key) => groups.get(key)).filter(Boolean);
  if (!entries.length) return [];

  const cleanedCurrentPlan = cleanServiceName(currentMainPlan || '');
  let primaryKey = '';
  let skipPrimaryFilter = false;

  if (cleanedCurrentPlan) {
    // A base plan is already established for this software record.
    // Try to find it among the invoice's line items.
    const currentKey = serviceGroupKey(cleanedCurrentPlan) || cleanedCurrentPlan.toLowerCase();
    const currentHit = entries.find(
      (e) => e.key === currentKey || isLikelySameServiceName(e.name, cleanedCurrentPlan)
    );
    if (currentHit) {
      // Base plan is in this invoice — filter it out; remaining items are add-ons.
      primaryKey = currentHit.key;
    } else {
      // Base plan is NOT in this invoice — this is a separate add-on invoice.
      // Treat every line item as an add-on; nothing to filter out.
      skipPrimaryFilter = true;
    }
  } else {
    // No established base plan — use parsedMainPlan to identify the primary line.
    const preferredPlan = cleanServiceName(parsedMainPlan || '');
    if (preferredPlan) {
      const preferredKey = serviceGroupKey(preferredPlan) || preferredPlan.toLowerCase();
      const hit = entries.find(
        (e) => e.key === preferredKey || isLikelySameServiceName(e.name, preferredPlan)
      );
      if (hit) primaryKey = hit.key;
    }
  }

  // Final fallback: when no plan name matched and we're not skipping, treat the
  // highest-amount item as the primary subscription line (original behaviour).
  if (!primaryKey && !skipPrimaryFilter) {
    primaryKey = [...entries]
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))[0]?.key || '';
  }

  if (!skipPrimaryFilter) {
    entries = entries.filter((e) => e.key !== primaryKey);
  }

  const renewal = normalizeBillingPeriod(billingPeriod || '');
  return entries
    .map((entry) => {
      const periodAmount = Number(entry.amount || 0);
      const annualCost = annualizeAmountForPeriod(periodAmount, renewal);
      if (!(Number.isFinite(annualCost) && annualCost > 0)) return null;

      const qtyCandidates = (entry.rows || [])
        .map((r) => Number(r?.quantity))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => Math.round(v));
      const qty = qtyCandidates.length ? Math.max(...qtyCandidates) : null;
      const explicitUnitCandidates = (entry.rows || [])
        .map((r) => Number(r?.unitPrice))
        .filter((v) => Number.isFinite(v) && v > 0)
        .map((v) => Number(v.toFixed(2)));
      const inferredFromRows = explicitUnitCandidates.length ? Math.max(...explicitUnitCandidates) : null;
      const monthlyUnit = (Number.isFinite(qty) && qty > 0)
        ? Number((annualCost / (qty * 12)).toFixed(2))
        : (Number.isFinite(inferredFromRows) && inferredFromRows > 0
          ? inferredFromRows
          : Number((annualCost / 12).toFixed(2)));

      return {
        name: entry.name,
        plan: entry.name,
        purchasedLicenses: Number.isFinite(qty) && qty > 0 ? qty : null,
        licensePricePerUserMonth: Number.isFinite(monthlyUnit) && monthlyUnit > 0 ? monthlyUnit : null,
        annualCost: Number(annualCost.toFixed(2)),
        renewalPeriod: renewal,
      };
    })
    .filter(Boolean);
}

function coerceLicenseQuantity(rawQty, lineItems = [], context = {}, warnings = []) {
  let qty = Number(rawQty);
  const seatSummary = summarizeSeatLines(lineItems);
  if (!Number.isFinite(qty)) {
    if (seatSummary.primaryQuantity > 0) return seatSummary.primaryQuantity;
    return null;
  }
  qty = Math.round(qty);
  if (qty <= 0 || qty > MAX_LICENSE_QTY || looksLikeDateQuantity(qty)) {
    if (seatSummary.primaryQuantity > 0) {
      warnings.push(`Adjusted suspicious license quantity ${rawQty} -> ${seatSummary.primaryQuantity} using primary non-prorated seat line`);
      return seatSummary.primaryQuantity;
    }
    warnings.push(`Discarded suspicious license quantity: ${rawQty}`);
    return null;
  }

  if (seatSummary.lineCount >= 2 && seatSummary.primaryQuantity > 0 && seatSummary.primaryQuantity !== qty) {
    if (qty === seatSummary.totalQuantity || seatSummary.quantities.includes(qty) || qty > seatSummary.primaryQuantity) {
      warnings.push(`Adjusted license quantity ${qty} -> ${seatSummary.primaryQuantity} (secondary service kept separate)`);
      qty = seatSummary.primaryQuantity;
    }
  }

  const lineQtys = (Array.isArray(lineItems) ? lineItems : [])
    .filter(li => String(li?.kind || '').toLowerCase() !== 'credit')
    .map(li => Number(li?.quantity))
    .filter(v => Number.isFinite(v) && v > 0 && v <= MAX_LICENSE_QTY && !looksLikeDateQuantity(v))
    .map(v => Math.round(v));

  if (lineQtys.length && !lineQtys.includes(qty)) {
    const nearest = lineQtys.reduce((best, v) => (Math.abs(v - qty) < Math.abs(best - qty) ? v : best), lineQtys[0]);
    if (qty > (nearest * 3) || Math.abs(qty - nearest) >= 250) {
      warnings.push(`Adjusted license quantity ${qty} -> ${nearest} using line-item quantities`);
      qty = nearest;
    }
  }

  const expectedQty = Number(context?.expectedLicenseQuantity);
  if (Number.isFinite(expectedQty) && expectedQty > 0) {
    const expected = Math.round(expectedQty);
    const isExtremeSpike = qty > (expected * 20) && (qty - expected) >= 1000;
    if (isExtremeSpike) {
      const fallbackQty = lineQtys.length ? lineQtys[0] : expected;
      warnings.push(`Adjusted extreme license spike ${qty} -> ${fallbackQty} using software context`);
      qty = fallbackQty;
    }
  }

  if (!(Number.isFinite(qty) && qty > 0 && qty <= MAX_LICENSE_QTY)) return null;
  return qty;
}

function normalizeParseResult(payload = {}, context = {}) {
  const confidence = ['high', 'medium', 'low'].includes(payload.confidence) ? payload.confidence : 'low';
  const amount = Number(payload.amount);
  const subtotal = Number(payload.subtotal);
  const taxTotal = Number(payload.taxTotal);
  const totalIncludingTaxes = Number(payload.totalIncludingTaxes);
  const invoiceBalance = Number(payload.invoiceBalance);
  const licenseUnitPrice = Number(payload.licenseUnitPrice);
  const billingPeriod = normalizeBillingPeriod(payload.billingPeriod || payload.renewalPeriod || '');
  const renewalPeriod = normalizeBillingPeriod(payload.renewalPeriod || payload.billingPeriod || '');
  let periodFrom = normalizeIsoDate(payload.periodFrom || '');
  let periodTo = normalizeIsoDate(payload.periodTo || '');
  const lineItems = (Array.isArray(payload.lineItems) ? payload.lineItems : []).map(normalizeLineItem);
  const seatSummary = summarizeSeatLines(lineItems);
  const warnings = Array.isArray(payload.warnings) ? [...payload.warnings] : [];
  if (periodFrom && periodTo) {
    const fromTs = Date.parse(`${periodFrom}T00:00:00Z`);
    const toTs = Date.parse(`${periodTo}T00:00:00Z`);
    if (Number.isFinite(fromTs) && Number.isFinite(toTs) && fromTs > toTs) {
      const tmp = periodFrom;
      periodFrom = periodTo;
      periodTo = tmp;
      warnings.push('Adjusted billing period dates: swapped periodFrom/periodTo to match chronological order');
    }
  }
  const licenseQuantity = coerceLicenseQuantity(payload.licenseQuantity, lineItems, context, warnings);
  let normalizedUnitPrice = Number.isFinite(licenseUnitPrice) && licenseUnitPrice > 0 ? licenseUnitPrice : null;
  if (!(Number.isFinite(normalizedUnitPrice) && normalizedUnitPrice > 0)
    && Number.isFinite(seatSummary.primaryUnitPrice) && seatSummary.primaryUnitPrice > 0) {
    normalizedUnitPrice = seatSummary.primaryUnitPrice;
  }
  if (!(Number.isFinite(normalizedUnitPrice) && normalizedUnitPrice > 0)
    && Number.isFinite(seatSummary.blendedUnitPrice) && seatSummary.blendedUnitPrice > 0) {
    normalizedUnitPrice = seatSummary.blendedUnitPrice;
  }
  if (payload.isProrated && Number.isFinite(seatSummary.blendedUnitPrice) && seatSummary.blendedUnitPrice > 0) {
    const blended = Number(seatSummary.blendedUnitPrice);
    if (!(Number.isFinite(normalizedUnitPrice) && normalizedUnitPrice > 0)
      || (Math.abs(normalizedUnitPrice - blended) / blended) > 0.1) {
      normalizedUnitPrice = blended;
      warnings.push('Adjusted unit price using non-prorated seat lines');
    }
  }
  if (seatSummary.hasMixedUnitPrices) {
    warnings.push('Multiple non-prorated seat unit prices detected; primary plan price used');
  }
  const normalizedSubscriptionPlan = String(payload.subscriptionPlan || '').trim() || seatSummary.primaryName || null;
  const additionalServices = seatSummary.additionalLines.map((li) => ({
    name: li.name,
    quantity: Number.isFinite(Number(li.quantity)) ? Math.round(Number(li.quantity)) : null,
    unitPrice: Number.isFinite(Number(li.unitPrice)) ? Number(Number(li.unitPrice).toFixed(2)) : null,
    subtotal: Number.isFinite(Number(li.subtotal)) ? Number(Number(li.subtotal).toFixed(2)) : null,
    total: Number.isFinite(Number(li.total)) ? Number(Number(li.total).toFixed(2)) : null,
  }));
  return {
    amount: Number.isFinite(amount) ? amount : null,
    subtotal: Number.isFinite(subtotal) ? subtotal : null,
    taxTotal: Number.isFinite(taxTotal) ? taxTotal : null,
    totalIncludingTaxes: Number.isFinite(totalIncludingTaxes) ? totalIncludingTaxes : null,
    invoiceBalance: Number.isFinite(invoiceBalance) ? invoiceBalance : null,
    currency: payload.currency || null,
    billingPeriod: billingPeriod || null,
    periodFrom,
    periodTo,
    confidence,
    localeCountry: payload.localeCountry || '',
    dateOrder: payload.dateOrder || 'MDY',
    licenseQuantity: Number.isFinite(licenseQuantity) ? Math.round(licenseQuantity) : null,
    licenseUnitPrice: Number.isFinite(normalizedUnitPrice) && normalizedUnitPrice > 0
      ? Number(normalizedUnitPrice.toFixed(2))
      : null,
    subscriptionPlan: normalizedSubscriptionPlan,
    renewalPeriod: renewalPeriod || null,
    fieldConfidence: payload.fieldConfidence && typeof payload.fieldConfidence === 'object' ? payload.fieldConfidence : {},
    needsReview: payload.needsReview === undefined ? confidence !== 'high' : Boolean(payload.needsReview),
    isProrated: Boolean(payload.isProrated),
    hasMultipleSubscriptions: Boolean(payload.hasMultipleSubscriptions),
    complexityReasons: Array.isArray(payload.complexityReasons) ? payload.complexityReasons : [],
    lineItems,
    additionalServices,
    source: payload.source || 'unknown',
    warnings,
    raw: payload.raw || '',
    rawFull: payload.rawFull || payload.raw || '',
  };
}

function trimInvoiceTextForPrompt(text = '', limit = CLAUDE_MAX_INPUT_CHARS) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  if (!clean) return '';
  if (clean.length <= limit) return clean;
  const headLen = Math.floor(limit * 0.65);
  const tailLen = Math.max(0, limit - headLen - 40);
  return `${clean.slice(0, headLen)}\n...[truncated]...\n${clean.slice(clean.length - tailLen)}`;
}

function numericNear(a, b, absEps = 0.01, relEps = 0.03) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const aa = Number(a);
  const bb = Number(b);
  const diff = Math.abs(aa - bb);
  const rel = diff / Math.max(Math.abs(aa), Math.abs(bb), 1);
  return diff <= absEps || rel <= relEps;
}

function collectCoreFieldMismatches(a = null, b = null) {
  if (!a || !b) return [];
  const out = [];
  const aq = Number(a.licenseQuantity);
  const bq = Number(b.licenseQuantity);
  if (Number.isFinite(aq) && Number.isFinite(bq) && Math.round(aq) !== Math.round(bq)) out.push('licenseQuantity');
  const au = Number(a.licenseUnitPrice);
  const bu = Number(b.licenseUnitPrice);
  if (Number.isFinite(au) && Number.isFinite(bu) && !numericNear(au, bu, 0.01, 0.03)) out.push('licenseUnitPrice');
  const aa = Number(a.amount);
  const ba = Number(b.amount);
  if (Number.isFinite(aa) && Number.isFinite(ba) && !numericNear(aa, ba, 0.5, 0.02)) out.push('amount');
  if (a.billingPeriod && b.billingPeriod && String(a.billingPeriod) !== String(b.billingPeriod)) out.push('billingPeriod');
  if (a.periodFrom && b.periodFrom && String(a.periodFrom) !== String(b.periodFrom)) out.push('periodFrom');
  if (a.periodTo && b.periodTo && String(a.periodTo) !== String(b.periodTo)) out.push('periodTo');
  return [...new Set(out)];
}

async function extractInvoiceText(base64Data = '') {
  const rawBase64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
  if (!rawBase64) return '';
  const buffer = Buffer.from(rawBase64, 'base64');
  const parsed = await pdf(buffer);
  const text = String(parsed?.text || '')
    .replace(/\u00A0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return trimInvoiceTextForPrompt(text);
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;
  const deFenced = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(deFenced);
  } catch {
    // continue
  }
  const first = deFenced.indexOf('{');
  const last = deFenced.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const candidate = deFenced.slice(first, last + 1);
    return JSON.parse(candidate);
  }
  return null;
}

async function parseInvoiceWithClaude(data = '', context = {}, requestId = '', candidateBundle = null) {
  if (!isClaudeReady()) return null;

  const nativeCandidate = candidateBundle && typeof candidateBundle === 'object'
    ? (candidateBundle.nativeCandidate || null)
    : candidateBundle;
  const ocrCandidate = candidateBundle && typeof candidateBundle === 'object'
    ? (candidateBundle.ocrCandidate || null)
    : null;

  let nativeText = String(candidateBundle?.nativeText || '').trim();
  if (!nativeText) {
    try {
      nativeText = await extractInvoiceText(data);
    } catch (err) {
      nativeText = '';
    }
  }
  const ocrTextRaw = String(candidateBundle?.ocrText || ocrCandidate?.rawFull || ocrCandidate?.raw || '').trim();
  const sourceLimit = Math.max(1200, Math.floor(CLAUDE_MAX_INPUT_CHARS / 2));
  nativeText = trimInvoiceTextForPrompt(nativeText, sourceLimit);
  const ocrText = trimInvoiceTextForPrompt(ocrTextRaw, sourceLimit);
  const invoiceText = [
    nativeText ? `NATIVE_PDF_TEXT:\n${nativeText}` : '',
    ocrText ? `OCR_TEXT:\n${ocrText}` : '',
  ].filter(Boolean).join('\n\n');

  if (!invoiceText) throw new Error('No native/OCR text extracted for Claude validation');

  const systemPrompt = [
    'You validate and correct invoice extraction for IT software asset tracking.',
    'Return ONLY valid JSON (no markdown, no commentary).',
    'Use this exact top-level shape:',
    '{"amount":number|null,"subtotal":number|null,"taxTotal":number|null,"totalIncludingTaxes":number|null,"invoiceBalance":number|null,"currency":string|null,"billingPeriod":"Monthly"|"Quarterly"|"Annual"|"Freeware"|"Pay-as-you-go"|null,"periodFrom":"YYYY-MM-DD"|null,"periodTo":"YYYY-MM-DD"|null,"licenseQuantity":number|null,"licenseUnitPrice":number|null,"subscriptionPlan":string|null,"renewalPeriod":"Monthly"|"Quarterly"|"Annual"|"Freeware"|"Pay-as-you-go"|null,"confidence":"high"|"medium"|"low","needsReview":boolean,"isProrated":boolean,"hasMultipleSubscriptions":boolean,"complexityReasons":string[],"warnings":string[],"lineItems":[{"name":string,"quantity":number|null,"unitPrice":number|null,"subtotal":number|null,"taxes":number|null,"total":number|null,"kind":"charge"|"credit"|"usage"|"other"}],"raw":string}',
    'You will receive native PDF parser and OCR parser candidates.',
    'Validate both candidates against invoice text. Correct any wrong field using invoice text.',
    'If candidate fields disagree, prefer the value best supported by invoice text.',
    'If both candidates miss a field and invoice text has it, fill it.',
    'If a field cannot be verified from invoice text, set null.',
    'When multiple seat/service rows exist (example: Full Seat + Dev Seat), include each in lineItems.',
    'Choose ONE primary non-prorated seat/service row (highest quantity, then highest amount).',
    'For licenseQuantity, use ONLY that primary row quantity.',
    'For licenseUnitPrice, use ONLY that primary row unit price.',
    'For subscriptionPlan, use that primary row name.',
    'Do not use prorated/credit/adjustment rows as primary seat quantity or unit price.',
    'Use null when unknown. Keep raw <= 500 chars.',
    'If invoice has credits/proration/multiple rows, set needsReview=true and lower confidence.',
  ].join('\n');

  const userPrompt = [
    `Context JSON: ${JSON.stringify(context || {})}`,
    `Native parser candidate JSON: ${JSON.stringify(nativeCandidate || {})}`,
    `OCR parser candidate JSON: ${JSON.stringify(ocrCandidate || {})}`,
    'Invoice text:',
    invoiceText,
  ].join('\n\n');

  const controller = new AbortController();
  const timer = setTimeout(() => {
    const timeoutError = new Error(`Claude request timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s`);
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
  }, CLAUDE_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        ...(requestId ? { 'x-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1400,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const isTimeout = String(reason?.name || '').toLowerCase() === 'timeouterror'
        || /timed out/i.test(String(reason?.message || ''));
      if (isTimeout) throw new Error(`Claude request timed out after ${Math.round(CLAUDE_TIMEOUT_MS / 1000)}s`);
      throw new Error('Claude request was canceled');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`Claude HTTP ${response.status}${errText ? `: ${errText.slice(0, 220)}` : ''}`);
  }

  const payload = await response.json();
  const text = Array.isArray(payload?.content)
    ? payload.content.filter(p => p?.type === 'text' && p?.text).map(p => p.text).join('\n')
    : '';
  const json = extractJsonObject(text);
  if (!json || typeof json !== 'object') {
    throw new Error('Claude returned invalid JSON payload');
  }

  const normalized = normalizeParseResult({
    ...json,
    source: 'claude-validated',
  }, context || {});
  normalized.warnings = [...(normalized.warnings || []), 'Validated/corrected by Claude against invoice text'];
  return normalized;
}

function sanitizeExtractRegions(input = {}) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const [key, region] of Object.entries(input)) {
    if (!region || typeof region !== 'object') continue;
    const x = Number(region.x);
    const y = Number(region.y);
    const w = Number(region.w);
    const h = Number(region.h);
    const page = Math.max(1, Math.round(Number(region.page || 1)));
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (x < 0 || y < 0 || w <= 0 || h <= 0) continue;
    if (x > 1 || y > 1 || w > 1 || h > 1) continue;
    if ((x + w) > (1 + REGION_EPSILON) || (y + h) > (1 + REGION_EPSILON)) continue;
    out[key] = { x, y, w, h, page };
  }
  return out;
}

async function parseInvoiceWithPython(data, context = {}, requestId = '') {
  if (!INVOICE_PARSER_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    const timeoutError = new Error(`Invoice parser timed out after ${Math.round(INVOICE_PARSER_TIMEOUT_MS / 1000)}s`);
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
  }, INVOICE_PARSER_TIMEOUT_MS);

  try {
    const response = await fetch(`${INVOICE_PARSER_URL}/parse-invoice`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(requestId ? { 'x-request-id': String(requestId) } : {}),
      },
      body: JSON.stringify({
        fileBase64: data,
        context,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Python parser HTTP ${response.status}`);
    const payload = await response.json();
    const normalized = normalizeParseResult(payload, context || {});
    normalized.raw = String(payload?.raw || normalized.raw || '');
    normalized.rawFull = String(payload?.rawFull || payload?.raw || normalized.rawFull || normalized.raw || '');
    if (payload?.source) normalized.source = String(payload.source);
    return normalized;
  } catch (err) {
    if (controller.signal.aborted) {
      const reason = controller.signal.reason;
      const isTimeout = String(reason?.name || '').toLowerCase() === 'timeouterror'
        || /timed out/i.test(String(reason?.message || ''));
      if (isTimeout) throw new Error(`Invoice parser timed out after ${Math.round(INVOICE_PARSER_TIMEOUT_MS / 1000)}s`);
      throw new Error('Invoice parser request was canceled');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function extractInvoiceFields(data, context = {}, requestId = '') {
  let result = null;
  let claudePrimaryError = null;
  let nativeCandidate = null;
  let ocrCandidate = null;
  let nativeText = '';

  // Always compute native PDF parser candidate first.
  try {
    nativeCandidate = normalizeParseResult(await parseInvoicePDF(data, { context }), context || {});
    nativeCandidate.source = nativeCandidate.source || 'js-native';
  } catch (err) {
    nativeCandidate = null;
  }
  try {
    nativeText = await extractInvoiceText(data);
  } catch {
    nativeText = '';
  }

  // OCR/parser candidate (if python parser service is configured).
  if (INVOICE_PARSER_URL) {
    try {
      ocrCandidate = await parseInvoiceWithPython(data, context, requestId);
    } catch (err) {
      ocrCandidate = null;
      if (nativeCandidate) {
        nativeCandidate.warnings = [
          ...(nativeCandidate.warnings || []),
          `OCR/parser candidate unavailable: ${err.message}`,
        ];
      }
    }
  }

  // Claude-first path (primary extractor), when configured.
  if (isClaudeReady()) {
    try {
      const claudePrimary = await parseInvoiceWithClaude(data, context, requestId, {
        nativeCandidate,
        ocrCandidate,
        nativeText,
        ocrText: String(ocrCandidate?.rawFull || ocrCandidate?.raw || '').trim(),
      });
      if (claudePrimary) {
        result = {
          ...normalizeParseResult(claudePrimary, context || {}),
          warnings: [
            ...(claudePrimary?.warnings || []),
            'Validated by Claude using native and OCR parser candidates',
          ],
        };
      }
    } catch (err) {
      claudePrimaryError = err;
    }
  }

  if (!result) {
    // Fallback preference: OCR/parser candidate first, then native PDF candidate.
    if (ocrCandidate) {
      result = normalizeParseResult(ocrCandidate, context || {});
      result.warnings = [...(result.warnings || []), 'Claude unavailable/failed, used OCR parser candidate'];
    } else if (nativeCandidate) {
      result = normalizeParseResult(nativeCandidate, context || {});
      result.source = 'js-fallback';
      result.warnings = [...(result.warnings || []), 'Claude unavailable/failed, used native PDF parser candidate'];
    }
  }

  if (!result) {
    result = normalizeParseResult({
      confidence: 'low',
      needsReview: true,
      warnings: ['No parser result available'],
      source: 'none',
    }, context || {});
  }

  if (claudePrimaryError) {
    result.warnings = [
      ...(result.warnings || []),
      `Claude primary extraction failed; fallback parser used: ${claudePrimaryError.message}`,
    ];
  }

  const dualMismatches = collectCoreFieldMismatches(nativeCandidate, ocrCandidate);
  if (dualMismatches.length) {
    result.warnings = [
      ...(result.warnings || []),
      `Native PDF vs OCR candidate mismatch on: ${dualMismatches.join(', ')}`,
    ];
    result.needsReview = true;
  } else if (nativeCandidate && ocrCandidate) {
    result.warnings = [
      ...(result.warnings || []),
      'Native PDF and OCR candidates agree on core fields',
    ];
  } else if (!ocrCandidate) {
    result.warnings = [
      ...(result.warnings || []),
      'OCR candidate unavailable; validation used native PDF extraction only',
    ];
  } else if (!nativeCandidate) {
    result.warnings = [
      ...(result.warnings || []),
      'Native PDF candidate unavailable; validation used OCR extraction only',
    ];
  }

  return result;
}

// ── GET /api/software ──────────────────────────────────────────────────────────
// Supports optional ?page=1&limit=50 query params.
// Defaults to returning all records (backward-compatible flat array).
router.get('/', requireAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.max(0, parseInt(req.query.limit) || 0); // 0 = no limit (default)
    const includeInvoicesRaw = String(req.query.includeInvoices || '').trim().toLowerCase();
    const includeInvoices = ['1', 'true', 'yes'].includes(includeInvoicesRaw);
    const projection = includeInvoices ? '' : '-invoices';
    const query = Software.find().select(projection).sort({ csvId: 1 }).lean();
    if (limit > 0) {
      const total = await Software.countDocuments();
      const list  = await query.skip((page - 1) * limit).limit(limit);
      return res.json({ total, page, limit, software: list.map(fmtSw) });
    }
    const list = await query;
    res.json(list.map(fmtSw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/software/budget — dashboard stats ─────────────────────────────────
router.get('/budget', requireAuth, async (req, res) => {
  try {
    const all = await Software.find()
      .select('name deploymentType status annualCost services purchasedLicenses usedLicenses')
      .lean();

    const totalSpend = all.reduce((s, x) => s + totalCost(x), 0);
    const saasSpend  = all.filter(x => x.deploymentType === 'SAAS').reduce((s, x) => s + totalCost(x), 0);
    const freeCount  = all.filter(x => totalCost(x) === 0).length;
    const paidCount  = all.filter(x => totalCost(x) > 0).length;
    const totalLic   = all.reduce((s, x) => s + (x.purchasedLicenses || 0), 0);
    const usedLic    = all.reduce((s, x) => s + (x.usedLicenses || 0), 0);
    const topApps    = [...all]
      .sort((a, b) => totalCost(b) - totalCost(a))
      .slice(0, 5)
      .map(x => ({
        csvId: x.csvId, name: x.name, annualCost: totalCost(x),
        baseCost: x.annualCost, serviceCount: (x.services || []).length,
        deploymentType: x.deploymentType, department: x.department,
      }));
    const byType = {};
    all.forEach(x => { const t = x.deploymentType; byType[t] = (byType[t] || 0) + totalCost(x); });

    res.json({ totalSpend, saasSpend, freeCount, paidCount, totalApps: all.length, totalLic, usedLic, topApps, byType });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/software/:id — single software details ───────────────────────────
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const softwareId = String(req.params.id || '').trim();
    if (!/^[a-f\d]{24}$/i.test(softwareId)) {
      return res.status(400).json({ error: 'Invalid software id' });
    }
    const includeInvoicesRaw = String(req.query.includeInvoices || '').trim().toLowerCase();
    const includeInvoices = ['1', 'true', 'yes'].includes(includeInvoicesRaw);
    const projection = includeInvoices ? '-invoices.data' : '-invoices';
    const sw = await Software.findById(softwareId).select(projection).lean();
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    res.json(fmtSw(sw));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/software ─────────────────────────────────────────────────────────
router.post('/', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    const sw = await Software.create(req.body);
    const o  = fmtSw(sw);
    await writeLog({
      eventType: 'software_created', entityType: 'software',
      entityId: o.id, entityLabel: o.name,
      summary: `Software added: ${o.name} (${o.csvId})`,
    });
    res.status(201).json(o);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── PUT /api/software/:id ──────────────────────────────────────────────────────
router.put('/:id', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    // Use findById + save so nested arrays (services) are properly validated
    const sw = await Software.findById(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const before = fmtSw(sw);

    const allowed = [
      'csvId', 'name', 'deploymentType', 'provisioningMethod', 'connectorType', 'supportsDeprovision',
      'provisioningNotes', 'renewalPeriod', 'department', 'purpose',
      'licensePricePerUserMonth', 'annualCost', 'subscriptionPlan', 'purchasedLicenses',
      'usedLicenses', 'owner', 'admins', 'billedTo', 'status',
      'siteUSA', 'siteCAN', 'siteIND', 'services',
    ];
    allowed.forEach(k => { if (req.body[k] !== undefined) sw[k] = req.body[k]; });
    await sw.save();

    const o = fmtSw(sw);
    const changes = diffSoftware(before, o);
    if (changes.length) {
      await writeLog({
        eventType: 'software_updated',
        entityType: 'software',
        entityId: o.id,
        entityLabel: o.name,
        changes,
        summary: `Software updated: ${o.name} (${o.csvId})`,
      });
    }
    res.json(o);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── DELETE /api/software/:id ───────────────────────────────────────────────────
router.delete('/:id', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    const sw = await Software.findByIdAndDelete(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const o = fmtSw(sw);
    await writeLog({
      eventType: 'software_deleted',
      entityType: 'software',
      entityId: o.id,
      entityLabel: o.name,
      summary: `Software deleted: ${o.name} (${o.csvId})`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/software/parse-invoice — extract fields from PDF (no save) ──────
// Body: { data: base64, context?: { billingAddress?, countryCode?, countryHints?, defaultCurrency? } }
// Returns parsed fields for the UI to pre-fill.
router.post('/parse-invoice', requireAuth, async (req, res) => {
  try {
    const { data, context = {} } = req.body || {};
    if (!data) return res.status(400).json({ error: 'data (base64) is required' });
    const reqId = req.get('x-request-id') || '';
    const result = await extractInvoiceFields(data, context, reqId);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/software/extract-regions — extract text from annotated bounding boxes ──
// Body: { data: base64, regions: { fieldKey: { x, y, w, h, page } } }
// Proxies to Python invoice-parser microservice /extract-regions (pdfplumber + OCR).
router.post('/extract-regions', requireAuth, async (req, res) => {
  try {
    const { data, fileBase64, regions } = req.body || {};
    const payload = fileBase64 || data;
    if (!payload)  return res.status(400).json({ error: 'data (base64) is required' });
    if (!regions || typeof regions !== 'object')
                   return res.status(400).json({ error: 'regions map is required' });
    const safeRegions = sanitizeExtractRegions(regions);
    if (!Object.keys(safeRegions).length) {
      return res.status(400).json({ error: 'at least one valid region is required' });
    }

    if (!INVOICE_PARSER_URL) {
      return res.status(503).json({ error: 'Python invoice-parser service not configured (INVOICE_PARSER_URL)' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => {
      const timeoutError = new Error(`Extract regions timed out after ${Math.round(INVOICE_PARSER_TIMEOUT_MS / 1000)}s`);
      timeoutError.name = 'TimeoutError';
      controller.abort(timeoutError);
    }, INVOICE_PARSER_TIMEOUT_MS);

    let upstream;
    try {
      upstream = await fetch(`${INVOICE_PARSER_URL}/extract-regions`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ fileBase64: payload, regions: safeRegions }),
        signal:  controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        const isTimeout = String(reason?.name || '').toLowerCase() === 'timeouterror'
          || /timed out/i.test(String(reason?.message || ''));
        if (isTimeout) return res.status(504).json({ error: `Extract regions timed out after ${Math.round(INVOICE_PARSER_TIMEOUT_MS / 1000)}s` });
        return res.status(499).json({ error: 'Extract regions request canceled' });
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const result = await upstream.json();
    res.status(upstream.status).json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/software/:id/invoices — upload an invoice ───────────────────────
// Body: { filename, data (base64), mimeType, amount, currency, note, softwareUpdate? }
router.post('/:id/invoices', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const reqId = req.get('x-request-id') || '';

    const {
      filename, data, mimeType = 'application/pdf',
      amount = 0, currency = 'USD', note = '',
      licenseQuantity = null,
      licenseUnitPrice = null,
      subscriptionPlan = '',
      billingPeriod = '', periodFrom = null, periodTo = null,
      parseConfidence = '',
      lineItems = [],
      softwareUpdate = null,
    } = req.body;
    if (!filename || !data) return res.status(400).json({ error: 'filename and data are required' });

    const normalizedInvoiceLineItems = (Array.isArray(lineItems) ? lineItems : [])
      .map(normalizeLineItem)
      .filter((li) => String(li?.name || '').trim() || Number.isFinite(Number(li?.total)));
    let effectiveLineItems = normalizedInvoiceLineItems;
    if (!effectiveLineItems.length && data) {
      try {
        const fallbackParsed = await extractInvoiceFields(data, {
          softwareName: sw.name,
          expectedLicenseQuantity: Number.isFinite(Number(sw.purchasedLicenses)) ? Math.round(Number(sw.purchasedLicenses)) : null,
          defaultCurrency: String(currency || 'USD').trim() || 'USD',
        }, reqId);
        const fallbackLineItems = (Array.isArray(fallbackParsed?.lineItems) ? fallbackParsed.lineItems : [])
          .map(normalizeLineItem)
          .filter((li) => String(li?.name || '').trim() || Number.isFinite(Number(li?.total)));
        if (fallbackLineItems.length) {
          effectiveLineItems = fallbackLineItems;
        }
      } catch (_) {
        // Best-effort fallback only; keep upload resilient even if parser service is unavailable.
      }
    }

    let additionalServicesToApply = [];
    if (softwareUpdate && typeof softwareUpdate === 'object') {
      const renewal = String(softwareUpdate.renewalPeriod || '').trim();
      if (['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''].includes(renewal)) {
        sw.renewalPeriod = renewal;
      }

      if (softwareUpdate.subscriptionPlan !== undefined) {
        sw.subscriptionPlan = String(softwareUpdate.subscriptionPlan || '').trim();
      }

      const annualCost = Number(softwareUpdate.annualCost);
      if (Number.isFinite(annualCost) && annualCost >= 0) {
        sw.annualCost = annualCost;
      }

      const purchasedLicenses = Number(softwareUpdate.purchasedLicenses);
      if (Number.isFinite(purchasedLicenses) && purchasedLicenses >= 0) {
        sw.purchasedLicenses = Math.round(purchasedLicenses);
      }

      const licensePrice = Number(softwareUpdate.licensePricePerUserMonth);
      if (Number.isFinite(licensePrice) && licensePrice >= 0) {
        sw.licensePricePerUserMonth = licensePrice;
      }

      const derivedAdditionalServices = (!Array.isArray(softwareUpdate.additionalServices) || !softwareUpdate.additionalServices.length)
        ? deriveAdditionalServicesFromLineItems({
          lineItems: effectiveLineItems,
          billingPeriod: String(billingPeriod || softwareUpdate.renewalPeriod || sw.renewalPeriod || '').trim(),
          currentMainPlan: String(sw.subscriptionPlan || '').trim(),
          parsedMainPlan: String(subscriptionPlan || softwareUpdate.subscriptionPlan || '').trim(),
        })
        : [];
      additionalServicesToApply = Array.isArray(softwareUpdate.additionalServices) && softwareUpdate.additionalServices.length
        ? softwareUpdate.additionalServices
        : derivedAdditionalServices;
    }

    if (!additionalServicesToApply.length) {
      additionalServicesToApply = deriveAdditionalServicesFromLineItems({
        lineItems: effectiveLineItems,
        billingPeriod: String(billingPeriod || softwareUpdate?.renewalPeriod || sw.renewalPeriod || '').trim(),
        currentMainPlan: String(sw.subscriptionPlan || '').trim(),
        parsedMainPlan: String(subscriptionPlan || softwareUpdate?.subscriptionPlan || '').trim(),
      });
    }

    if (Array.isArray(additionalServicesToApply) && additionalServicesToApply.length) {
      for (const svc of additionalServicesToApply) {
        const name = String(svc?.name || '').trim();
        if (!name) continue;
        const normName = name.toLowerCase();
        const existing = (sw.services || []).find((row) => String(row?.name || '').trim().toLowerCase() === normName);
        const svcQtyRaw = Number(svc?.purchasedLicenses);
        const svcPriceRaw = Number(svc?.licensePricePerUserMonth);
        const svcAnnualRaw = Number(svc?.annualCost);
        const svcQty = Number.isFinite(svcQtyRaw) && svcQtyRaw > 0 ? Math.round(svcQtyRaw) : null;
        const svcAnnual = Number.isFinite(svcAnnualRaw) && svcAnnualRaw > 0 ? Number(svcAnnualRaw) : null;
        let svcPrice = Number.isFinite(svcPriceRaw) && svcPriceRaw > 0 ? Number(svcPriceRaw) : null;
        if (!(Number.isFinite(svcPrice) && svcPrice > 0) && Number.isFinite(svcAnnual) && svcAnnual > 0 && Number.isFinite(svcQty) && svcQty > 0) {
          svcPrice = Number((svcAnnual / (svcQty * 12)).toFixed(2));
        }
        if (!(Number.isFinite(svcPrice) && svcPrice > 0) && Number.isFinite(svcAnnual) && svcAnnual > 0) {
          svcPrice = Number((svcAnnual / 12).toFixed(2));
        }
        const svcPlan = String(svc?.plan || '').trim();
        const svcRenewal = String(svc?.renewalPeriod || '').trim();
        if (existing) {
          if (Number.isFinite(svcQty) && svcQty > 0) existing.purchasedLicenses = svcQty;
          if (Number.isFinite(svcPrice) && svcPrice > 0) existing.licensePricePerUserMonth = svcPrice;
          if (Number.isFinite(svcAnnual) && svcAnnual > 0) existing.annualCost = svcAnnual;
          if (svcPlan) existing.plan = svcPlan;
          if (['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''].includes(svcRenewal)) {
            existing.renewalPeriod = svcRenewal;
          }
          if (!existing.status) existing.status = 'Active';
        } else {
          sw.services.push({
            name,
            plan: svcPlan,
            annualCost: Number.isFinite(svcAnnual) && svcAnnual > 0 ? svcAnnual : 0,
            licensePricePerUserMonth: Number.isFinite(svcPrice) && svcPrice > 0 ? svcPrice : 0,
            purchasedLicenses: Number.isFinite(svcQty) && svcQty > 0 ? svcQty : 0,
            usedLicenses: 0,
            renewalPeriod: ['Annual', 'Monthly', 'Quarterly', 'Freeware', 'Pay-as-you-go', ''].includes(svcRenewal) ? svcRenewal : '',
            status: 'Active',
          });
        }
      }
    }

    sw.invoices.push({
      filename, data, mimeType, amount, currency, note,
      licenseQuantity: Number.isFinite(Number(licenseQuantity)) ? Math.round(Number(licenseQuantity)) : null,
      licenseUnitPrice: Number.isFinite(Number(licenseUnitPrice)) ? Number(Number(licenseUnitPrice).toFixed(2)) : null,
      subscriptionPlan: String(subscriptionPlan || '').trim(),
      billingPeriod, parseConfidence,
      periodFrom: periodFrom ? new Date(periodFrom) : null,
      periodTo:   periodTo   ? new Date(periodTo)   : null,
      lineItems: effectiveLineItems,
    });
    await sw.save();

    const inv = sw.invoices[sw.invoices.length - 1];
    await writeLog({
      eventType: 'software_updated', entityType: 'software',
      entityId: sw._id.toString(), entityLabel: sw.name,
      summary: `Invoice uploaded: ${filename} → ${sw.name}`,
    });

    // Return invoice metadata (no base64 blob) + updated services array so the
    // client can immediately sync the Add-on Services table without a second fetch.
    res.status(201).json({
      id: inv._id.toString(), filename: inv.filename,
      uploadedAt: inv.uploadedAt, amount: inv.amount,
      currency: inv.currency, licenseQuantity: inv.licenseQuantity ?? null,
      licenseUnitPrice: inv.licenseUnitPrice ?? null,
      subscriptionPlan: inv.subscriptionPlan || '',
      note: inv.note, mimeType: inv.mimeType,
      billingPeriod: inv.billingPeriod,
      periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      parseConfidence: inv.parseConfidence,
      source: inv.source || 'manual',
      sourceProvider: inv.sourceProvider || '',
      sourceMessageId: inv.sourceMessageId || '',
      reviewRequired: !!inv.reviewRequired,
      matchScore: Number.isFinite(Number(inv.matchScore)) ? Number(inv.matchScore) : 0,
      extractionSource: inv.extractionSource || '',
      lineItems: Array.isArray(inv.lineItems) ? inv.lineItems : [],
      // Updated add-on services after invoice-derived derivation
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
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /api/software/:id/invoices — list invoices (metadata only) ─────────────
router.get('/:id/invoices', requireAuth, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id).select('invoices').lean();
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const dateMs = (value) => {
      if (!value) return 0;
      const ms = Date.parse(String(value));
      return Number.isFinite(ms) ? ms : 0;
    };
    const list = (sw.invoices || []).map(inv => ({
      id: inv._id.toString(), filename: inv.filename,
      uploadedAt: inv.uploadedAt, amount: inv.amount,
      currency: inv.currency, licenseQuantity: inv.licenseQuantity ?? null,
      licenseUnitPrice: inv.licenseUnitPrice ?? null,
      subscriptionPlan: inv.subscriptionPlan || '',
      note: inv.note, mimeType: inv.mimeType,
      billingPeriod: inv.billingPeriod,
      periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      parseConfidence: inv.parseConfidence,
      source: inv.source || 'manual',
      sourceProvider: inv.sourceProvider || '',
      sourceMessageId: inv.sourceMessageId || '',
      reviewRequired: !!inv.reviewRequired,
      matchScore: Number.isFinite(Number(inv.matchScore)) ? Number(inv.matchScore) : 0,
      extractionSource: inv.extractionSource || '',
      lineItems: Array.isArray(inv.lineItems) ? inv.lineItems : [],
    })).sort((a, b) => {
      const bEnd = dateMs(b.periodTo) || dateMs(b.periodFrom) || dateMs(b.uploadedAt);
      const aEnd = dateMs(a.periodTo) || dateMs(a.periodFrom) || dateMs(a.uploadedAt);
      if (bEnd !== aEnd) return bEnd - aEnd;

      const bStart = dateMs(b.periodFrom) || dateMs(b.periodTo) || dateMs(b.uploadedAt);
      const aStart = dateMs(a.periodFrom) || dateMs(a.periodTo) || dateMs(a.uploadedAt);
      if (bStart !== aStart) return bStart - aStart;

      return dateMs(b.uploadedAt) - dateMs(a.uploadedAt);
    });
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GET /api/software/:id/invoices/:invId/download — download invoice file ─────
router.get('/:id/invoices/:invId/download', requireAuth, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id).select('invoices').lean();
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const inv = (sw.invoices || []).find(i => i._id.toString() === req.params.invId);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const buffer = Buffer.from(inv.data.replace(/^data:[^;]+;base64,/, ''), 'base64');
    res.setHeader('Content-Type', inv.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${inv.filename}"`);
    res.send(buffer);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── DELETE /api/software/:id/invoices/:invId — delete an invoice ───────────────
router.delete('/:id/invoices/:invId', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const inv = sw.invoices.id(req.params.invId);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });
    const fname = inv.filename;
    inv.deleteOne();
    await sw.save();
    await writeLog({
      eventType: 'software_updated', entityType: 'software',
      entityId: sw._id.toString(), entityLabel: sw.name,
      summary: `Invoice deleted: ${fname} from ${sw.name}`,
    });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
module.exports.extractInvoiceFields = extractInvoiceFields;
module.exports.deriveAdditionalServicesFromLineItems = deriveAdditionalServicesFromLineItems;
