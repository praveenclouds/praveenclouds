/**
 * utils/invoice-parser.js — PDF Invoice Auto-Parser
 *
 * Goal:
 * - Parse invoices across countries/currencies/date formats
 * - Bias ambiguous date/number parsing using billing-address locale hints
 *
 * Returns:
 *  {
 *    amount:        number | null,
 *    currency:      string | null,
 *    billingPeriod: 'Monthly' | 'Quarterly' | 'Annual' | null,
 *    periodFrom:    ISO date string | null,
 *    periodTo:      ISO date string | null,
 *    confidence:    'high' | 'medium' | 'low',
 *    localeCountry: string,
 *    dateOrder:     'DMY' | 'MDY' | 'YMD',
 *    raw:           string (first 500 chars)
 *  }
 */

const pdf = require('pdf-parse');

const MONTHS = {
  january: 0, jan: 0, janvier: 0, enero: 0, janeiro: 0, januar: 0,
  february: 1, feb: 1, fevrier: 1, febrero: 1, fevereiro: 1, februar: 1,
  march: 2, mar: 2, mars: 2, marzo: 2, marz: 2,
  april: 3, apr: 3, avril: 3, abril: 3,
  may: 4, mai: 4, mayo: 4,
  june: 5, jun: 5, juin: 5, junio: 5,
  july: 6, jul: 6, juillet: 6, julio: 6,
  august: 7, aug: 7, aout: 7, agosto: 7,
  september: 8, sep: 8, sept: 8, septembre: 8, septiembre: 8,
  october: 9, oct: 9, octobre: 9, octubre: 9,
  november: 10, nov: 10, novembre: 10, noviembre: 10,
  december: 11, dec: 11, decembre: 11, diciembre: 11, dezember: 11,
};

const COUNTRY_LOCALE = {
  US: { dateOrder: 'MDY', currency: 'USD', decimalSeparator: '.' },
  CA: { dateOrder: 'MDY', currency: 'CAD', decimalSeparator: '.' },
  IN: { dateOrder: 'DMY', currency: 'INR', decimalSeparator: '.' },
  GB: { dateOrder: 'DMY', currency: 'GBP', decimalSeparator: '.' },
  IE: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: '.' },
  AU: { dateOrder: 'DMY', currency: 'AUD', decimalSeparator: '.' },
  NZ: { dateOrder: 'DMY', currency: 'NZD', decimalSeparator: '.' },
  SG: { dateOrder: 'DMY', currency: 'SGD', decimalSeparator: '.' },
  AE: { dateOrder: 'DMY', currency: 'AED', decimalSeparator: '.' },
  SA: { dateOrder: 'DMY', currency: 'SAR', decimalSeparator: '.' },
  QA: { dateOrder: 'DMY', currency: 'QAR', decimalSeparator: '.' },
  KW: { dateOrder: 'DMY', currency: 'KWD', decimalSeparator: '.' },
  JP: { dateOrder: 'YMD', currency: 'JPY', decimalSeparator: '.' },
  CN: { dateOrder: 'YMD', currency: 'CNY', decimalSeparator: '.' },
  KR: { dateOrder: 'YMD', currency: 'KRW', decimalSeparator: '.' },
  HK: { dateOrder: 'DMY', currency: 'HKD', decimalSeparator: '.' },
  TW: { dateOrder: 'YMD', currency: 'TWD', decimalSeparator: '.' },
  MY: { dateOrder: 'DMY', currency: 'MYR', decimalSeparator: '.' },
  TH: { dateOrder: 'DMY', currency: 'THB', decimalSeparator: '.' },
  ID: { dateOrder: 'DMY', currency: 'IDR', decimalSeparator: ',' },
  PH: { dateOrder: 'MDY', currency: 'PHP', decimalSeparator: '.' },
  VN: { dateOrder: 'DMY', currency: 'VND', decimalSeparator: ',' },
  DE: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  FR: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  ES: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  IT: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  NL: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  BE: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  LU: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  AT: { dateOrder: 'DMY', currency: 'EUR', decimalSeparator: ',' },
  CH: { dateOrder: 'DMY', currency: 'CHF', decimalSeparator: '.' },
  SE: { dateOrder: 'YMD', currency: 'SEK', decimalSeparator: ',' },
  NO: { dateOrder: 'DMY', currency: 'NOK', decimalSeparator: ',' },
  DK: { dateOrder: 'DMY', currency: 'DKK', decimalSeparator: ',' },
  PL: { dateOrder: 'DMY', currency: 'PLN', decimalSeparator: ',' },
  CZ: { dateOrder: 'DMY', currency: 'CZK', decimalSeparator: ',' },
  HU: { dateOrder: 'DMY', currency: 'HUF', decimalSeparator: ',' },
  RO: { dateOrder: 'DMY', currency: 'RON', decimalSeparator: ',' },
  BR: { dateOrder: 'DMY', currency: 'BRL', decimalSeparator: ',' },
  MX: { dateOrder: 'DMY', currency: 'MXN', decimalSeparator: '.' },
  ZA: { dateOrder: 'YMD', currency: 'ZAR', decimalSeparator: '.' },
  TR: { dateOrder: 'DMY', currency: 'TRY', decimalSeparator: ',' },
};

const COUNTRY_ALIASES = {
  US: ['united states', 'usa', 'u.s.a', 'u.s.'],
  CA: ['canada'],
  IN: ['india'],
  GB: ['united kingdom', 'great britain', 'england', 'uk'],
  IE: ['ireland'],
  AU: ['australia'],
  NZ: ['new zealand'],
  SG: ['singapore'],
  AE: ['united arab emirates', 'uae'],
  SA: ['saudi arabia'],
  QA: ['qatar'],
  KW: ['kuwait'],
  JP: ['japan'],
  CN: ['china', 'prc'],
  KR: ['south korea', 'korea republic'],
  HK: ['hong kong'],
  TW: ['taiwan'],
  MY: ['malaysia'],
  TH: ['thailand'],
  ID: ['indonesia'],
  PH: ['philippines'],
  VN: ['vietnam'],
  DE: ['germany', 'deutschland'],
  FR: ['france'],
  ES: ['spain', 'espana'],
  IT: ['italy', 'italia'],
  NL: ['netherlands', 'holland'],
  BE: ['belgium'],
  LU: ['luxembourg'],
  AT: ['austria'],
  CH: ['switzerland'],
  SE: ['sweden'],
  NO: ['norway'],
  DK: ['denmark'],
  PL: ['poland'],
  CZ: ['czech republic', 'czechia'],
  HU: ['hungary'],
  RO: ['romania'],
  BR: ['brazil', 'brasil'],
  MX: ['mexico'],
  ZA: ['south africa'],
  TR: ['turkey'],
};

const SYMBOL_TO_CURRENCY = {
  '$': 'USD',
  'US$': 'USD',
  'C$': 'CAD',
  'A$': 'AUD',
  'NZ$': 'NZD',
  'S$': 'SGD',
  'HK$': 'HKD',
  'NT$': 'TWD',
  'R$': 'BRL',
  'MX$': 'MXN',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  '₪': 'ILS',
  '₫': 'VND',
  '₴': 'UAH',
  '₱': 'PHP',
  '₺': 'TRY',
  '₦': 'NGN',
  '₡': 'CRC',
  '₭': 'LAK',
  '₲': 'PYG',
  '₵': 'GHS',
  '฿': 'THB',
  '₸': 'KZT',
  '₼': 'AZN',
  '₾': 'GEL',
};

function normalizeText(value = '') {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandYear(yearToken) {
  const year = Number(yearToken);
  if (!Number.isFinite(year)) return null;
  if (yearToken.length >= 4) return year;
  return year <= 69 ? (2000 + year) : (1900 + year);
}

function buildDate(y, m, d) {
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(year, month - 1, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== (month - 1) || dt.getDate() !== day) return null;
  return dt;
}

function toISO(d) {
  if (!d || Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function normalizeCurrency(raw = '') {
  let token = String(raw || '').trim();
  if (!token) return '';
  token = token.replace(/[()]/g, '').trim();
  if (SYMBOL_TO_CURRENCY[token]) return SYMBOL_TO_CURRENCY[token];

  const upper = token.toUpperCase();
  if (SYMBOL_TO_CURRENCY[upper]) return SYMBOL_TO_CURRENCY[upper];
  if (/^[A-Z]{3}$/.test(upper)) return upper;

  // Cases like "USDCurrency" or "CurrencyUSD"
  const embedded = upper.match(/([A-Z]{3})/);
  if (embedded && /^[A-Z]{3}$/.test(embedded[1])) return embedded[1];
  return '';
}

function detectCurrencyFromText(flat = '') {
  const probes = [
    /\bcurrency\s*[:\-]?\s*([A-Z]{3})\b/i,
    /\b([A-Z]{3})\s*currency\b/i,
    /\((USD|EUR|GBP|CAD|INR|AUD|NZD|SGD|AED|SAR|QAR|KWD|JPY|CNY|CHF|SEK|NOK|DKK|BRL|MXN|ZAR|TRY|PLN|CZK|HUF|RON|THB|IDR|KRW|HKD|TWD|MYR|PHP|VND)\)/i,
    /(US\$|C\$|A\$|NZ\$|S\$|HK\$|NT\$|R\$|MX\$|[$€£¥₹₩₽₪₫₴₱₺₦₡₭₲₵฿₸₼₾])\s*\d/i,
  ];
  for (const probe of probes) {
    const match = flat.match(probe);
    if (!match) continue;
    const token = match[1] || match[0];
    const normalized = normalizeCurrency(token);
    if (normalized) return normalized;
  }
  return '';
}

function parseLocalizedAmount(raw, locale = {}) {
  if (raw === undefined || raw === null) return null;
  let value = String(raw)
    .replace(/\u00A0/g, ' ')
    .replace(/[^0-9,.'\-\s]/g, '')
    .trim();
  if (!value) return null;

  const hasComma = value.includes(',');
  const hasDot = value.includes('.');
  let decimalSep = '';

  if (hasComma && hasDot) {
    decimalSep = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
  } else if (hasComma) {
    decimalSep = /,\d{1,2}$/.test(value) ? ',' : '';
    if (!decimalSep && locale.decimalSeparator === ',') decimalSep = ',';
  } else if (hasDot) {
    decimalSep = /\.\d{1,2}$/.test(value) ? '.' : '';
    if (!decimalSep && locale.decimalSeparator === '.') decimalSep = '.';
  }

  value = value.replace(/[\s']/g, '');
  const thousandSep = decimalSep === ',' ? '.' : (decimalSep === '.' ? ',' : '');
  if (thousandSep) {
    value = value.split(thousandSep).join('');
  } else {
    // No clear decimal separator; remove grouping punctuation.
    value = value.replace(/[,.]/g, '');
  }

  if (decimalSep && decimalSep !== '.') {
    value = value.replace(decimalSep, '.');
  }

  // Keep only one decimal point (last one wins).
  const dotParts = value.split('.');
  if (dotParts.length > 2) {
    const fraction = dotParts.pop();
    value = `${dotParts.join('')}.${fraction}`;
  }

  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return null;
  return num;
}

function isReasonableAmount(numberValue, rawToken = '') {
  if (!Number.isFinite(numberValue) || numberValue <= 0) return false;
  if (numberValue > 1_000_000_000) return false;
  const raw = String(rawToken || '').trim();
  // Avoid invoice/order identifiers (very long digits without separators)
  if (/^\d{9,}$/.test(raw)) return false;
  // Must have decimal places — bare integers are likely dates, quantities or IDs
  if (!/[.,]\d{1,2}$/.test(raw.replace(/\s/g, ''))) return false;
  return true;
}

// Returns true if a number looks like it was parsed from a date string
function looksLikeDateNumber(n) {
  if (!Number.isFinite(n)) return false;
  const s = String(Math.round(Math.abs(n)));
  // 6-digit numbers like 122026 (from "12/2026" or "12, 2026")
  if (s.length === 6 && Number(s.slice(2)) >= 1900 && Number(s.slice(2)) <= 2100) return true;
  // Plain years 1900–2100
  if (n >= 1900 && n <= 2100 && Number.isInteger(n)) return true;
  return false;
}

function parseAmountCandidate(text, locale = {}) {
  const source = String(text || '');
  if (!source) return null;

  const patterns = [
    /\((?<currency>[A-Z]{3})\)\s*(?<amount>[0-9][0-9,.'\s-]*\d)/i,
    /(?<currency>US\$|C\$|A\$|NZ\$|S\$|HK\$|NT\$|R\$|MX\$|[A-Z]{3}|[$€£¥₹₩₽₪₫₴₱₺₦₡₭₲₵฿₸₼₾])\s*(?<amount>[0-9][0-9,.'\s-]*\d)/i,
    /(?<amount>[0-9][0-9,.'\s-]*\d)\s*(?<currency>[A-Z]{3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;
    const groups = match.groups || {};
    const amountToken = groups.amount || '';
    const currencyToken = groups.currency || '';
    const amount = parseLocalizedAmount(amountToken, locale);
    if (!isReasonableAmount(amount, amountToken)) continue;
    return {
      amount,
      currency: normalizeCurrency(currencyToken),
      amountToken,
    };
  }
  return null;
}

function detectBillingKeyword(flat = '') {
  if (/(annual|yearly|annually|annuel|anual)\s+(subscription|plan|invoice|billing|term|period)/i.test(flat)) return 'Annual';
  if (/(quarterly|quarter|trimestral|trimestrial)\s+(subscription|plan|invoice|billing|term|period)/i.test(flat)) return 'Quarterly';
  if (/(monthly|mensual|mensuel|monatlich|per\s+month)\s*(subscription|plan|invoice|billing|term|period)?/i.test(flat)) return 'Monthly';
  return null;
}

function inferPeriod(from, to) {
  if (!from || !to) return null;
  const days = Math.round((to.getTime() - from.getTime()) / 86400000);
  if (days >= 350 && days <= 380) return 'Annual';
  if (days >= 85 && days <= 95) return 'Quarterly';
  if (days >= 27 && days <= 34) return 'Monthly';
  return null;
}

function normalizeCountryCode(input = '') {
  const value = String(input || '').trim().toUpperCase();
  if (!value) return '';
  if (COUNTRY_LOCALE[value]) return value;
  if (value === 'UK') return 'GB';
  if (value === 'UAE') return 'AE';
  if (value === 'USA') return 'US';
  return '';
}

function findCountryCodeInText(text = '') {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return '';

  for (const [code, aliases] of Object.entries(COUNTRY_ALIASES)) {
    for (const alias of aliases) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`\\b${escaped}\\b`, 'i');
      if (regex.test(normalized)) return code;
    }
  }
  return '';
}

function resolveLocaleProfile(context = {}, flat = '') {
  const hints = [];
  if (context.country) hints.push(String(context.country));
  if (context.countryCode) hints.push(String(context.countryCode));
  if (Array.isArray(context.countryHints)) hints.push(...context.countryHints.map(String));
  if (context.billingAddress) hints.push(String(context.billingAddress));
  hints.push(String(flat || ''));

  let countryCode = '';
  for (const hint of hints) {
    countryCode = normalizeCountryCode(hint) || findCountryCodeInText(hint);
    if (countryCode) break;
  }

  const base = countryCode ? COUNTRY_LOCALE[countryCode] : null;
  const defaultCurrency = normalizeCurrency(context.defaultCurrency)
    || (base ? base.currency : '')
    || 'USD';

  return {
    countryCode: countryCode || 'US',
    dateOrder: (base && base.dateOrder) || 'MDY',
    decimalSeparator: (base && base.decimalSeparator) || '.',
    defaultCurrency,
  };
}

function parseDate(rawInput, locale = {}) {
  if (!rawInput) return null;
  let input = normalizeText(rawInput);
  if (!input) return null;

  // Remove day suffixes: 1st, 2nd, 3rd, 21st
  input = input.replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1');
  // Remove trailing time / timezone information
  input = input.replace(/(?:\s+|T)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*[A-Z]{2,5})?$/i, '').trim();

  let match = input.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (match) return buildDate(match[1], match[2], match[3]);

  match = input.match(/^(\d{1,2})[\/\-.]([A-Za-z]{3,20})[\/\-.](\d{2,4})$/);
  if (match) {
    const month = MONTHS[String(match[2] || '').toLowerCase().replace(/\./g, '')];
    const year = expandYear(match[3]);
    if (month !== undefined && year) return buildDate(year, month + 1, match[1]);
  }

  match = input.match(/^([A-Za-z]{3,20})\.?\s+(\d{1,2}),?\s+(\d{2,4})$/);
  if (match) {
    const month = MONTHS[String(match[1] || '').toLowerCase().replace(/\./g, '')];
    const year = expandYear(match[3]);
    if (month !== undefined && year) return buildDate(year, month + 1, match[2]);
  }

  match = input.match(/^(\d{1,2})\s+([A-Za-z]{3,20})\s+(\d{2,4})$/);
  if (match) {
    const month = MONTHS[String(match[2] || '').toLowerCase().replace(/\./g, '')];
    const year = expandYear(match[3]);
    if (month !== undefined && year) return buildDate(year, month + 1, match[1]);
  }

  match = input.match(/^([A-Za-z]{3,20})\s+(\d{2,4})$/);
  if (match) {
    const month = MONTHS[String(match[1] || '').toLowerCase().replace(/\./g, '')];
    const year = expandYear(match[2]);
    if (month !== undefined && year) return buildDate(year, month + 1, 1);
  }

  match = input.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = expandYear(match[3]);
    if (!year) return null;

    let day;
    let month;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else if ((locale.dateOrder || 'MDY') === 'DMY') {
      day = first;
      month = second;
    } else {
      month = first;
      day = second;
    }
    return buildDate(year, month, day);
  }

  return null;
}

function normalizeDateRange(start, end) {
  if (!start || !end) return { start, end };
  if (start.getTime() <= end.getTime()) return { start, end };
  return { start: end, end: start };
}

const DATE_TOKEN = '(?:\\d{4}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{1,2}|\\d{1,2}[\\/\\-.][A-Za-z]{3,20}[\\/\\-.]\\d{2,4}|\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}|[A-Za-z]{3,20}\\.?\\s+\\d{1,2},?\\s+\\d{2,4}|\\d{1,2}\\s+[A-Za-z]{3,20}\\s+\\d{2,4}|[A-Za-z]{3,20}\\s+\\d{2,4})';

const RANGE_PATTERNS = [
  new RegExp(`service\\s+(?:term|period)\\s*[:\\-–—]?\\s*(${DATE_TOKEN})\\s*(?:to|until|till|through|au|a|–|—|-)\\s*(${DATE_TOKEN})`, 'i'),
  new RegExp(`billing\\s+period\\s*[:\\-–—]?\\s*(${DATE_TOKEN})\\s*(?:to|until|till|through|au|a|–|—|-)\\s*(${DATE_TOKEN})`, 'i'),
  new RegExp(`invoice\\s+period\\s*[:\\-–—]?\\s*(${DATE_TOKEN})\\s*(?:to|until|till|through|au|a|–|—|-)\\s*(${DATE_TOKEN})`, 'i'),
  new RegExp(`(?:subscription|coverage|usage|validity|period)\\s*[:\\-–—]?\\s*(${DATE_TOKEN})\\s*(?:to|until|till|through|au|a|–|—|-)\\s*(${DATE_TOKEN})`, 'i'),
  new RegExp(`(${DATE_TOKEN})\\s*(?:to|until|till|through|au|a|–|—|-)\\s*(${DATE_TOKEN})`, 'i'),
];

const SINGLE_DATE_PATTERNS = [
  /invoice\s+date\s*[:\-–—]?\s*([^\n]+)/i,
  /date\s+of\s+issue\s*[:\-–—]?\s*([^\n]+)/i,
  /issued\s*[:\-–—]?\s*([^\n]+)/i,
  /service\s+date\s*[:\-–—]?\s*([^\n]+)/i,
];

function extractRange(flat, locale = {}) {
  for (const pattern of RANGE_PATTERNS) {
    const match = flat.match(pattern);
    if (!match) continue;
    const from = parseDate(match[1], locale);
    const to = parseDate(match[2], locale);
    if (!from || !to) continue;
    const normalized = normalizeDateRange(from, to);
    return {
      periodFrom: toISO(normalized.start),
      periodTo: toISO(normalized.end),
    };
  }
  return { periodFrom: null, periodTo: null };
}

function extractSingleDateRange(flat, locale = {}) {
  for (const pattern of SINGLE_DATE_PATTERNS) {
    const match = flat.match(pattern);
    if (!match) continue;
    const date = parseDate(match[1], locale);
    if (!date) continue;
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0);
    return {
      periodFrom: toISO(date),
      periodTo: toISO(end),
    };
  }
  return { periodFrom: null, periodTo: null };
}

function extractAmount(flat, lines = [], locale = {}) {
  const keywordRank = [
    ['grand total', 1],
    ['invoice total', 2],
    ['total due', 3],
    ['amount due', 4],
    ['total payable', 5],
    ['balance due', 6],
    ['net amount', 7],
    ['total', 20],
  ];

  const candidates = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = line.toLowerCase();
    const rankInfo = keywordRank.find(([k]) => lower.includes(k));
    if (!rankInfo) continue;

    const primary = parseAmountCandidate(line, locale);
    if (primary) candidates.push({ ...primary, rank: rankInfo[1] });

    if (!primary && lines[i + 1]) {
      const merged = parseAmountCandidate(`${line} ${lines[i + 1]}`, locale);
      if (merged) candidates.push({ ...merged, rank: rankInfo[1] + 1 });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => a.rank - b.rank);
    return { amount: candidates[0].amount, currency: candidates[0].currency };
  }

  // Flat fallback for single-line PDFs.
  const fallback = parseAmountCandidate(flat, locale);
  if (fallback) return { amount: fallback.amount, currency: fallback.currency };

  return { amount: null, currency: '' };
}

function parseIntegerToken(raw = '') {
  const cleaned = String(raw || '').replace(/[^0-9]/g, '');
  if (!cleaned) return null;
  const num = Number.parseInt(cleaned, 10);
  if (!Number.isFinite(num)) return null;
  return num;
}

function isValidLicenseQty(n) {
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n > 10000) return false;          // >10k is not a realistic license count
  if (looksLikeDateNumber(n)) return false; // reject date fragments like 122026
  return true;
}

function extractLicenseQuantity(lines = [], flat = '') {
  const probes = [
    /(?:qty|quantity|license\s*quantity|licenses?\s*ordered|licenses?|licences?|seats?|users?)\s*[:\-]?\s*([0-9][0-9,.\s]*)/i,
    /([0-9][0-9,.\s]*)\s*(?:licenses?|licences?|seats?|users?)\b/i,
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lower = String(line || '').toLowerCase();
    if (!/(qty|quantity|license|licence|seat|user)/i.test(lower)) continue;
    for (const probe of probes) {
      const match = line.match(probe);
      if (!match) continue;
      const quantity = parseIntegerToken(match[1]);
      if (!isValidLicenseQty(quantity)) continue;
      return quantity;
    }

    // Multiline fallback: next line after "Quantity" header must be a plain integer
    const next = String(lines[i + 1] || '');
    if (next && /^\s*\d{1,5}\s*$/.test(next)) {  // strict: only plain short integers
      const nextToken = parseIntegerToken(next);
      if (isValidLicenseQty(nextToken)) return nextToken;
    }
  }

  // Unit token style rows (compact tables): e.g. "Acrobat Pro 8 EA 23.99"
  for (const line of lines) {
    const match = String(line || '').match(/([0-9]{1,5})\s*(?:EA|EACH|SEATS?|USERS?|LIC(?:ENSE)?S?)(?=[^A-Za-z]|$)/i);
    if (!match) continue;
    const quantity = parseIntegerToken(match[1]);
    if (isValidLicenseQty(quantity)) return quantity;
  }

  // Flat fallback — only if keyword appears on same line as the number
  for (const probe of probes) {
    const match = String(flat || '').match(probe);
    if (!match) continue;
    const quantity = parseIntegerToken(match[1]);
    if (!isValidLicenseQty(quantity)) continue;
    return quantity;
  }
  const unitMatch = String(flat || '').match(/([0-9]{1,5})\s*(?:EA|EACH|SEATS?|USERS?|LIC(?:ENSE)?S?)(?=[^A-Za-z]|$)/i);
  if (unitMatch) {
    const quantity = parseIntegerToken(unitMatch[1]);
    if (isValidLicenseQty(quantity)) return quantity;
  }

  return null;
}

function extractSubscriptionPlan(lines = [], flat = '') {
  const probes = [
    /(?:subscription\s*plan|plan|edition|package|tier)\s*[:\-]\s*([^\n]+)/i,
    /(?:selected|current)\s*plan\s*[:\-]\s*([^\n]+)/i,
  ];

  const normalizePlan = (value) => {
    const plan = String(value || '').replace(/\s+/g, ' ').trim();
    if (!plan) return '';
    if (plan.length > 80) return '';
    if (/[0-9]{3,}/.test(plan) && /[$€£¥₹]/.test(plan)) return '';
    return plan;
  };

  for (const line of lines) {
    for (const probe of probes) {
      const match = line.match(probe);
      if (!match) continue;
      const plan = normalizePlan(match[1]);
      if (plan) return plan;
    }
  }

  for (const probe of probes) {
    const match = String(flat || '').match(probe);
    if (!match) continue;
    const plan = normalizePlan(match[1]);
    if (plan) return plan;
  }

  return null;
}

function extractLicenseUnitPrice(lines = [], flat = '', locale = {}) {
  const keywordProbe = /(unit\s*price|price\s*per\s*(user|seat|license)|per\s*(user|seat|license)|license\s*price|seat\s*price|rate)/i;
  for (const line of lines) {
    if (!keywordProbe.test(line)) continue;
    const amount = parseAmountCandidate(line, locale);
    if (amount && Number.isFinite(amount.amount) && amount.amount > 0) {
      return amount.amount;
    }
  }

  // Pattern fallback: "$12.34 per user / month"
  const inline = String(flat || '').match(/([A-Z]{3}|US\$|C\$|A\$|NZ\$|S\$|HK\$|NT\$|R\$|MX\$|[$€£¥₹₩₽₪₫₴₱₺₦₡₭₲₵฿₸₼₾])?\s*([0-9][0-9,.'\s-]*\d)\s*(?:\/|per)\s*(?:user|seat|license)/i);
  if (inline) {
    const parsed = parseLocalizedAmount(inline[2], locale);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  return null;
}

// ── Try invoice-parser microservice first ────────────────────────────────────
const https = require('https');
const http  = require('http');

const PARSER_URL = process.env.INVOICE_PARSER_URL || 'http://invoice-parser:8001';
const PARSER_TIMEOUT_MS = parseInt(process.env.INVOICE_PARSER_TIMEOUT_MS || '30000', 10);

function callParserService(base64Data, context = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ fileBase64: base64Data, context });
    const url  = new URL('/parse-invoice', PARSER_URL);
    const opts = {
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  PARSER_TIMEOUT_MS,
    };

    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(opts, (res) => {
      let raw = '';
      res.on('data', chunk => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(raw) });
        } catch {
          resolve({ ok: false, error: 'Parser service returned non-JSON' });
        }
      });
    });

    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'Parser service timeout' }); });
    req.on('error',   (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

async function parseInvoicePDF(base64Data, options = {}) {
  // ── 1. Try invoice-parser microservice (Python FastAPI, more accurate) ────
  try {
    const svcResult = await callParserService(base64Data, options.context || {});
    if (svcResult.ok && svcResult.data && svcResult.data.confidence !== 'low') {
      return { ...svcResult.data, method: 'python-service' };
    }
  } catch (_) { /* fall through to JS parser */ }

  // ── 2. Fall back to JS parser ─────────────────────────────────────────────
  const context = options.context || {};
  const rawBase64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
  const buffer = Buffer.from(rawBase64, 'base64');

  let text = '';
  try {
    const parsed = await pdf(buffer);
    text = parsed.text || '';
  } catch (error) {
    return {
      amount: null,
      currency: null,
      billingPeriod: null,
      periodFrom: null,
      periodTo: null,
      confidence: 'low',
      localeCountry: '',
      dateOrder: 'MDY',
      licenseQuantity: null,
      licenseUnitPrice: null,
      subscriptionPlan: null,
      renewalPeriod: null,
      raw: '',
      error: `PDF parse failed: ${error.message}`,
    };
  }

  const lines = String(text || '')
    .split(/\r?\n/)
    .map(line => normalizeText(line))
    .filter(Boolean);
  const flat = normalizeText(text);

  const locale = resolveLocaleProfile(context, flat);

  const amountData = extractAmount(flat, lines, locale);
  const amount = amountData.amount;

  const explicitCurrency = normalizeCurrency(amountData.currency)
    || detectCurrencyFromText(flat)
    || locale.defaultCurrency;
  const currency = explicitCurrency || 'USD';

  let { periodFrom, periodTo } = extractRange(flat, locale);
  if (!periodFrom || !periodTo) {
    const single = extractSingleDateRange(flat, locale);
    periodFrom = periodFrom || single.periodFrom;
    periodTo = periodTo || single.periodTo;
  }

  let billingPeriod = detectBillingKeyword(flat);
  if (periodFrom && periodTo) {
    const inferred = inferPeriod(new Date(periodFrom), new Date(periodTo));
    if (inferred) billingPeriod = inferred;
  }
  const renewalPeriod = billingPeriod || null;

  const licenseQuantity = extractLicenseQuantity(lines, flat);
  const licenseUnitPrice = extractLicenseUnitPrice(lines, flat, locale);
  const subscriptionPlan = extractSubscriptionPlan(lines, flat);

  let score = 0;
  if (amount !== null) score += 1;
  if (periodFrom) score += 1;
  if (periodTo) score += 1;
  if (billingPeriod) score += 1;

  const confidence = score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    amount,
    currency,
    billingPeriod: billingPeriod || null,
    periodFrom: periodFrom || null,
    periodTo: periodTo || null,
    confidence,
    localeCountry: locale.countryCode || '',
    dateOrder: locale.dateOrder || 'MDY',
    licenseQuantity: Number.isFinite(licenseQuantity) ? licenseQuantity : null,
    licenseUnitPrice: Number.isFinite(licenseUnitPrice) ? licenseUnitPrice : null,
    subscriptionPlan: subscriptionPlan || null,
    renewalPeriod,
    raw: flat.slice(0, 500),
  };
}

module.exports = { parseInvoicePDF };
