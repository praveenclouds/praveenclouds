#!/usr/bin/env python3
"""
utils/invoice_ocr.py — Python PDF invoice extractor
Uses pdfplumber for structured table extraction + pytesseract for image-based PDFs.

Called by invoice-parser.js via child_process:
  python3 utils/invoice_ocr.py <base64_pdf>

Returns JSON to stdout:
  {
    "amount": 776.82,
    "currency": "USD",
    "billingPeriod": "Monthly",
    "periodFrom": "2026-02-12",
    "periodTo": "2026-09-14",
    "licenseQuantity": 60,
    "confidence": "high",
    "raw": "..."
  }

Install dependencies:
  pip install pdfplumber pytesseract pillow pdf2image
  brew install tesseract   # macOS
  apt install tesseract-ocr # Ubuntu/Docker
"""

import sys
import json
import base64
import io
import re
import os
from datetime import datetime, date
from calendar import monthrange

# ── Try imports ────────────────────────────────────────────────────────────────
try:
    import pdfplumber
    HAS_PDFPLUMBER = True
except ImportError:
    HAS_PDFPLUMBER = False

try:
    from pdf2image import convert_from_bytes
    import pytesseract
    HAS_OCR = True
except ImportError:
    HAS_OCR = False

# ── Month name map ─────────────────────────────────────────────────────────────
MONTHS = {
    'january':1,'jan':1,'february':2,'feb':2,'march':3,'mar':3,
    'april':4,'apr':4,'may':5,'june':6,'jun':6,'july':7,'jul':7,
    'august':8,'aug':8,'september':9,'sep':9,'sept':9,
    'october':10,'oct':10,'november':11,'nov':11,'december':12,'dec':12,
}

# ── Currency symbols ───────────────────────────────────────────────────────────
SYMBOL_MAP = {'$':'USD','€':'EUR','£':'GBP','₹':'INR','C$':'CAD','A$':'AUD'}

def parse_date(s):
    """Parse common date formats. Returns date object or None."""
    if not s:
        return None
    s = s.strip().replace('\u00a0', ' ')
    # Remove day suffixes
    s = re.sub(r'\b(\d{1,2})(st|nd|rd|th)\b', r'\1', s, flags=re.I)

    patterns = [
        # ISO: 2026-02-12
        (r'(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})', lambda m: (int(m[1]),int(m[2]),int(m[3]))),
        # Month name: Feb 12, 2026 / February 12 2026
        (r'([A-Za-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})', lambda m: (int(m[3]), MONTHS.get(m[1].lower()), int(m[2]))),
        # 12 Feb 2026
        (r'(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})', lambda m: (int(m[3]), MONTHS.get(m[2].lower()), int(m[1]))),
        # US numeric: 02/12/2026
        (r'(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})', lambda m: (int(m[3]),int(m[1]),int(m[2]))),
        # Month Year: Feb 2026
        (r'([A-Za-z]+)\s+(\d{4})$', lambda m: (int(m[2]), MONTHS.get(m[1].lower()), 1)),
    ]
    for pattern, extractor in patterns:
        match = re.search(pattern, s)
        if not match:
            continue
        try:
            y, mo, d = extractor(match.groups())
            if mo and 1 <= mo <= 12 and 1 <= d <= 31 and 1900 <= y <= 2100:
                return date(y, mo, d)
        except (ValueError, TypeError):
            continue
    return None

def infer_period(from_date, to_date):
    """Infer billing period from date gap."""
    if not from_date or not to_date:
        return None
    days = (to_date - from_date).days
    if 350 <= days <= 380:
        return 'Annual'
    if 85 <= days <= 95:
        return 'Quarterly'
    if 27 <= days <= 34:
        return 'Monthly'
    return None

def is_date_like_number(n):
    """Returns True if a number looks like it came from a date (e.g. 122026)."""
    if n is None:
        return False
    s = str(int(abs(n)))
    if len(s) == 6 and 1900 <= int(s[2:]) <= 2100:
        return True
    if 1900 <= n <= 2100 and n == int(n):
        return True
    return False

def extract_amount_from_text(text):
    """
    Extract invoice total from text. Prefers labelled totals with decimal values.
    Requires .XX decimal places to avoid matching dates/IDs.
    """
    currency = 'USD'
    amount = None

    # Priority patterns — must have decimal places
    priority_patterns = [
        r'(?:grand\s+total|invoice\s+total|total\s+due|amount\s+due|total\s+payable|balance\s+due)\s*[:\s]*([£€$₹]|USD|EUR|GBP|CAD|INR)?\s*([1-9][\d,]*\.\d{2})',
        r'\btotal\b\s*[:\s]*([£€$₹]|USD|EUR|GBP|CAD|INR)?\s*([1-9][\d,]*\.\d{2})',
        r'\bsubtotal\b\s*[:\s]*([£€$₹]|USD|EUR|GBP|CAD|INR)?\s*([1-9][\d,]*\.\d{2})',
        r'([£€$₹])\s*([1-9][\d,]*\.\d{2})',
        r'\b(USD|EUR|GBP|CAD|INR)\s+([1-9][\d,]*\.\d{2})',
    ]

    for pat in priority_patterns:
        for match in re.finditer(pat, text, re.I):
            groups = match.groups()
            curr_token = groups[0] or ''
            amt_token  = groups[1] if len(groups) > 1 else groups[0]
            try:
                val = float(amt_token.replace(',', ''))
                if val > 0 and not is_date_like_number(val):
                    amount = val
                    c = SYMBOL_MAP.get(curr_token.strip(), curr_token.strip().upper())
                    if c and len(c) == 3:
                        currency = c
                    return amount, currency
            except (ValueError, AttributeError):
                continue

    return amount, currency

def extract_dates_from_text(text):
    """Extract billing period date range from text."""
    DATE_TOKEN = r'(?:[A-Za-z]+\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\s+[A-Za-z]+\s+\d{4}|\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|[A-Za-z]+\s+\d{4})'
    SEP = r'(?:\s+to\s+|\s*[–—\-]\s*|\s+through\s+|\s+until\s+)'

    range_patterns = [
        rf'(?:billing\s+period|service\s+(?:term|period)|invoice\s+period|subscription|period)\s*[:\-]?\s*({DATE_TOKEN}){SEP}({DATE_TOKEN})',
        rf'({DATE_TOKEN}){SEP}({DATE_TOKEN})',
    ]

    for pat in range_patterns:
        matches = list(re.finditer(pat, text, re.I))
        for match in matches:
            g = match.groups()
            d1 = parse_date(g[-2])
            d2 = parse_date(g[-1])
            if d1 and d2:
                start, end = (d1, d2) if d1 <= d2 else (d2, d1)
                # Sanity check — gap shouldn't exceed 2 years
                if (end - start).days <= 730:
                    return start, end
    return None, None

def extract_license_qty_from_tables(tables):
    """Extract license quantity from structured table data."""
    qty_keywords = re.compile(r'\b(qty|quantity|licenses?|licences?|seats?|units?)\b', re.I)
    for table in tables:
        if not table:
            continue
        # Find header row with quantity column
        for row_idx, row in enumerate(table):
            row_strs = [str(c or '').strip() for c in row]
            qty_col = next((i for i, c in enumerate(row_strs) if qty_keywords.search(c)), None)
            if qty_col is None:
                continue
            # Check next rows for numeric value in that column
            for data_row in table[row_idx+1:]:
                if not data_row or qty_col >= len(data_row):
                    continue
                cell = str(data_row[qty_col] or '').strip()
                try:
                    val = int(float(cell.replace(',', '')))
                    if 1 <= val <= 10000 and not is_date_like_number(val):
                        return val
                except (ValueError, TypeError):
                    continue
    return None

def extract_from_pdf_bytes(pdf_bytes):
    """Main extraction using pdfplumber."""
    result = {
        'amount': None, 'currency': 'USD',
        'billingPeriod': None, 'periodFrom': None, 'periodTo': None,
        'licenseQuantity': None, 'confidence': 'low', 'raw': '',
    }

    if not HAS_PDFPLUMBER:
        result['error'] = 'pdfplumber not installed'
        return result

    try:
        with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf_doc:
            all_text = ''
            all_tables = []

            for page in pdf_doc.pages:
                page_text = page.extract_text() or ''
                all_text += page_text + '\n'
                tables = page.extract_tables()
                if tables:
                    all_tables.extend(tables)

        result['raw'] = all_text[:500]

        # ── Amount ───────────────────────────────────────────────────────────
        amount, currency = extract_amount_from_text(all_text)
        if amount:
            result['amount'] = round(amount, 2)
            result['currency'] = currency or 'USD'

        # ── Date range ───────────────────────────────────────────────────────
        from_date, to_date = extract_dates_from_text(all_text)
        if from_date:
            result['periodFrom'] = from_date.isoformat()
        if to_date:
            result['periodTo'] = to_date.isoformat()

        # ── Billing period ───────────────────────────────────────────────────
        period = infer_period(from_date, to_date)
        if not period:
            if re.search(r'\b(annual|yearly)\b', all_text, re.I): period = 'Annual'
            elif re.search(r'\b(quarterly)\b', all_text, re.I): period = 'Quarterly'
            elif re.search(r'\b(monthly|per\s+month)\b', all_text, re.I): period = 'Monthly'
        result['billingPeriod'] = period

        # ── License quantity (from tables first, then text) ──────────────────
        qty = extract_license_qty_from_tables(all_tables)
        if not qty:
            # fallback: match "60 seats" / "60 licenses" in text
            m = re.search(r'\b(\d{1,4})\s+(?:licenses?|licences?|seats?|users?)\b', all_text, re.I)
            if m:
                val = int(m.group(1))
                if not is_date_like_number(val):
                    qty = val
        result['licenseQuantity'] = qty

        # ── Confidence ───────────────────────────────────────────────────────
        score = sum([
            result['amount'] is not None,
            result['periodFrom'] is not None,
            result['periodTo'] is not None,
            result['billingPeriod'] is not None,
        ])
        result['confidence'] = 'high' if score >= 3 else 'medium' if score >= 2 else 'low'

    except Exception as e:
        result['error'] = str(e)
        result['confidence'] = 'low'

    return result

def try_ocr_fallback(pdf_bytes):
    """OCR fallback for image-based PDFs using pytesseract."""
    if not HAS_OCR:
        return None
    try:
        images = convert_from_bytes(pdf_bytes, dpi=200)
        all_text = ''
        for img in images:
            all_text += pytesseract.image_to_string(img) + '\n'

        amount, currency = extract_amount_from_text(all_text)
        from_date, to_date = extract_dates_from_text(all_text)
        period = infer_period(from_date, to_date)

        score = sum([amount is not None, from_date is not None, to_date is not None, period is not None])
        return {
            'amount': round(amount, 2) if amount else None,
            'currency': currency or 'USD',
            'billingPeriod': period,
            'periodFrom': from_date.isoformat() if from_date else None,
            'periodTo': to_date.isoformat() if to_date else None,
            'licenseQuantity': None,
            'confidence': 'high' if score >= 3 else 'medium' if score >= 2 else 'low',
            'raw': all_text[:500],
            'method': 'ocr',
        }
    except Exception as e:
        return {'error': str(e), 'confidence': 'low'}

# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == '__main__':
    raw_input = sys.argv[1] if len(sys.argv) > 1 else sys.stdin.read().strip()
    raw_input = re.sub(r'^data:[^;]+;base64,', '', raw_input)

    try:
        pdf_bytes = base64.b64decode(raw_input)
    except Exception as e:
        print(json.dumps({'error': f'base64 decode failed: {e}', 'confidence': 'low'}))
        sys.exit(0)

    result = extract_from_pdf_bytes(pdf_bytes)

    # If pdfplumber got low confidence, try OCR
    if result.get('confidence') == 'low' and HAS_OCR:
        ocr = try_ocr_fallback(pdf_bytes)
        if ocr and ocr.get('confidence', 'low') != 'low':
            result = ocr

    print(json.dumps(result))
