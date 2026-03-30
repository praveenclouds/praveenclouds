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

const INVOICE_PARSER_URL = String(process.env.INVOICE_PARSER_URL || '').trim().replace(/\/$/, '');
const INVOICE_PARSER_TIMEOUT_MS = Math.max(1000, Number(process.env.INVOICE_PARSER_TIMEOUT_MS || 30000));

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

function normalizeParseResult(payload = {}) {
  const confidence = ['high', 'medium', 'low'].includes(payload.confidence) ? payload.confidence : 'low';
  const amount = Number(payload.amount);
  const licenseQuantity = Number(payload.licenseQuantity);
  const licenseUnitPrice = Number(payload.licenseUnitPrice);
  return {
    amount: Number.isFinite(amount) ? amount : null,
    currency: payload.currency || null,
    billingPeriod: payload.billingPeriod || null,
    periodFrom: payload.periodFrom || null,
    periodTo: payload.periodTo || null,
    confidence,
    localeCountry: payload.localeCountry || '',
    dateOrder: payload.dateOrder || 'MDY',
    licenseQuantity: Number.isFinite(licenseQuantity) ? Math.round(licenseQuantity) : null,
    licenseUnitPrice: Number.isFinite(licenseUnitPrice) ? licenseUnitPrice : null,
    subscriptionPlan: payload.subscriptionPlan || null,
    renewalPeriod: payload.renewalPeriod || null,
    fieldConfidence: payload.fieldConfidence && typeof payload.fieldConfidence === 'object' ? payload.fieldConfidence : {},
    needsReview: Boolean(payload.needsReview),
    source: payload.source || 'unknown',
    warnings: Array.isArray(payload.warnings) ? payload.warnings : [],
    raw: payload.raw || '',
  };
}

async function parseInvoiceWithPython(data, context = {}, requestId = '') {
  if (!INVOICE_PARSER_URL) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVOICE_PARSER_TIMEOUT_MS);

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
    return normalizeParseResult(payload);
  } finally {
    clearTimeout(timer);
  }
}

// ── GET /api/software ──────────────────────────────────────────────────────────
// Supports optional ?page=1&limit=50 query params.
// Defaults to returning all records (backward-compatible flat array).
router.get('/', requireAuth, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.max(0, parseInt(req.query.limit) || 0); // 0 = no limit (default)

    const query = Software.find().sort({ csvId: 1 });
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
    const all = await Software.find().lean();

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

    let result = null;
    if (INVOICE_PARSER_URL) {
      try {
        result = await parseInvoiceWithPython(data, context, reqId);
      } catch (err) {
        console.warn(`⚠️  invoice parser (python) failed, falling back to JS parser: ${err.message}`);
      }
    }

    if (!result) {
      result = normalizeParseResult(await parseInvoicePDF(data, { context }));
      result.source = 'js-fallback';
      if (INVOICE_PARSER_URL) {
        result.warnings = [...(result.warnings || []), 'Python parser unavailable, used JS fallback'];
      }
    }

    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/software/:id/invoices — upload an invoice ───────────────────────
// Body: { filename, data (base64), mimeType, amount, currency, note, softwareUpdate? }
router.post('/:id/invoices', requireAuth, canWriteSoftware, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id);
    if (!sw) return res.status(404).json({ error: 'Software not found' });

    const {
      filename, data, mimeType = 'application/pdf',
      amount = 0, currency = 'USD', note = '',
      licenseQuantity = null,
      billingPeriod = '', periodFrom = null, periodTo = null,
      parseConfidence = '',
      softwareUpdate = null,
    } = req.body;
    if (!filename || !data) return res.status(400).json({ error: 'filename and data are required' });

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
    }

    sw.invoices.push({
      filename, data, mimeType, amount, currency, note,
      licenseQuantity: Number.isFinite(Number(licenseQuantity)) ? Math.round(Number(licenseQuantity)) : null,
      billingPeriod, parseConfidence,
      periodFrom: periodFrom ? new Date(periodFrom) : null,
      periodTo:   periodTo   ? new Date(periodTo)   : null,
    });
    await sw.save();

    const inv = sw.invoices[sw.invoices.length - 1];
    await writeLog({
      eventType: 'software_updated', entityType: 'software',
      entityId: sw._id.toString(), entityLabel: sw.name,
      summary: `Invoice uploaded: ${filename} → ${sw.name}`,
    });

    // Return metadata only (not the base64 blob)
    res.status(201).json({
      id: inv._id.toString(), filename: inv.filename,
      uploadedAt: inv.uploadedAt, amount: inv.amount,
      currency: inv.currency, licenseQuantity: inv.licenseQuantity ?? null, note: inv.note, mimeType: inv.mimeType,
      billingPeriod: inv.billingPeriod,
      periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      parseConfidence: inv.parseConfidence,
    });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ── GET /api/software/:id/invoices — list invoices (metadata only) ─────────────
router.get('/:id/invoices', requireAuth, async (req, res) => {
  try {
    const sw = await Software.findById(req.params.id).select('invoices').lean();
    if (!sw) return res.status(404).json({ error: 'Software not found' });
    const list = (sw.invoices || []).map(inv => ({
      id: inv._id.toString(), filename: inv.filename,
      uploadedAt: inv.uploadedAt, amount: inv.amount,
      currency: inv.currency, licenseQuantity: inv.licenseQuantity ?? null, note: inv.note, mimeType: inv.mimeType,
      billingPeriod: inv.billingPeriod,
      periodFrom: inv.periodFrom, periodTo: inv.periodTo,
      parseConfidence: inv.parseConfidence,
    }));
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
