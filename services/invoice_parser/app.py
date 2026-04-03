import base64
import io
import os
import re
from datetime import date, datetime
from typing import Any, Dict, List, Optional, Tuple

from fastapi import FastAPI
from pydantic import BaseModel, Field
from pypdf import PdfReader

app = FastAPI(title="Terzo Invoice Parser", version="1.0.0")

MONTHS = {
    "jan": 1, "january": 1,
    "feb": 2, "february": 2,
    "mar": 3, "march": 3,
    "apr": 4, "april": 4,
    "may": 5,
    "jun": 6, "june": 6,
    "jul": 7, "july": 7,
    "aug": 8, "august": 8,
    "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10,
    "nov": 11, "november": 11,
    "dec": 12, "december": 12,
}

COUNTRY_LOCALE: Dict[str, Dict[str, str]] = {
    "US": {"dateOrder": "MDY", "currency": "USD", "decimal": "."},
    "CA": {"dateOrder": "MDY", "currency": "CAD", "decimal": "."},
    "IN": {"dateOrder": "DMY", "currency": "INR", "decimal": "."},
    "GB": {"dateOrder": "DMY", "currency": "GBP", "decimal": "."},
    "AU": {"dateOrder": "DMY", "currency": "AUD", "decimal": "."},
    "NZ": {"dateOrder": "DMY", "currency": "NZD", "decimal": "."},
    "SG": {"dateOrder": "DMY", "currency": "SGD", "decimal": "."},
    "AE": {"dateOrder": "DMY", "currency": "AED", "decimal": "."},
    "JP": {"dateOrder": "YMD", "currency": "JPY", "decimal": "."},
    "DE": {"dateOrder": "DMY", "currency": "EUR", "decimal": ","},
    "FR": {"dateOrder": "DMY", "currency": "EUR", "decimal": ","},
    "ES": {"dateOrder": "DMY", "currency": "EUR", "decimal": ","},
    "IT": {"dateOrder": "DMY", "currency": "EUR", "decimal": ","},
    "NL": {"dateOrder": "DMY", "currency": "EUR", "decimal": ","},
    "BR": {"dateOrder": "DMY", "currency": "BRL", "decimal": ","},
    "MX": {"dateOrder": "DMY", "currency": "MXN", "decimal": "."},
}

COUNTRY_ALIASES: Dict[str, List[str]] = {
    "US": ["united states", "usa", "u.s."],
    "CA": ["canada"],
    "IN": ["india"],
    "GB": ["united kingdom", "uk", "great britain", "england"],
    "AU": ["australia"],
    "NZ": ["new zealand"],
    "SG": ["singapore"],
    "AE": ["uae", "united arab emirates"],
    "JP": ["japan"],
    "DE": ["germany", "deutschland"],
    "FR": ["france"],
    "ES": ["spain", "espana"],
    "IT": ["italy", "italia"],
    "NL": ["netherlands", "holland"],
    "BR": ["brazil", "brasil"],
    "MX": ["mexico"],
}

CURRENCY_BY_SYMBOL = {
    "$": "USD",
    "US$": "USD",
    "C$": "CAD",
    "A$": "AUD",
    "NZ$": "NZD",
    "S$": "SGD",
    "HK$": "HKD",
    "R$": "BRL",
    "MX$": "MXN",
    "EUR": "EUR",
    "GBP": "GBP",
    "INR": "INR",
    "AUD": "AUD",
    "CAD": "CAD",
    "USD": "USD",
    "JPY": "JPY",
    "CNY": "CNY",
    "AED": "AED",
    "SGD": "SGD",
    "€": "EUR",
    "£": "GBP",
    "¥": "JPY",
    "₹": "INR",
}


class ParseContext(BaseModel):
    billingAddress: str = ""
    countryCode: str = ""
    countryHints: List[str] = Field(default_factory=list)
    defaultCurrency: str = ""


class ParseRequest(BaseModel):
    fileBase64: Optional[str] = None
    data: Optional[str] = None
    fileName: str = ""
    mimeType: str = "application/pdf"
    context: ParseContext = Field(default_factory=ParseContext)


class ParsedLineItem(BaseModel):
    name: str = ""
    quantity: Optional[int] = None
    unitPrice: Optional[float] = None
    subtotal: Optional[float] = None
    taxes: Optional[float] = None
    total: Optional[float] = None
    kind: str = "other"


class ParseResponse(BaseModel):
    amount: Optional[float] = None
    currency: Optional[str] = None
    billingPeriod: Optional[str] = None
    periodFrom: Optional[str] = None
    periodTo: Optional[str] = None
    licenseQuantity: Optional[int] = None
    licenseUnitPrice: Optional[float] = None
    subscriptionPlan: Optional[str] = None
    renewalPeriod: Optional[str] = None
    confidence: str = "low"
    fieldConfidence: Dict[str, float] = Field(default_factory=dict)
    needsReview: bool = True
    source: str = "text"
    warnings: List[str] = Field(default_factory=list)
    subtotal: Optional[float] = None
    taxTotal: Optional[float] = None
    totalIncludingTaxes: Optional[float] = None
    invoiceBalance: Optional[float] = None
    lineItems: List[ParsedLineItem] = Field(default_factory=list)
    isProrated: bool = False
    hasMultipleSubscriptions: bool = False
    complexityReasons: List[str] = Field(default_factory=list)
    localeCountry: str = "US"
    dateOrder: str = "MDY"
    raw: str = ""
    rawFull: str = ""


def normalize_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", (value or "")).strip()


def normalize_country_code(value: str) -> str:
    v = (value or "").strip().upper()
    if v in COUNTRY_LOCALE:
        return v
    aliases = {"USA": "US", "UK": "GB", "UAE": "AE"}
    return aliases.get(v, "")


def find_country_code_in_text(text: str) -> str:
    lower = normalize_spaces(text).lower()
    if not lower:
        return ""
    for code, aliases in COUNTRY_ALIASES.items():
        for alias in aliases:
            if re.search(rf"\b{re.escape(alias)}\b", lower):
                return code
    return ""


def resolve_locale(context: ParseContext, text: str) -> Dict[str, str]:
    hints = []
    if context.countryCode:
        hints.append(context.countryCode)
    if context.billingAddress:
        hints.append(context.billingAddress)
    hints.extend(context.countryHints or [])
    hints.append(text)

    code = ""
    for hint in hints:
        code = normalize_country_code(hint) or find_country_code_in_text(hint)
        if code:
            break

    base = COUNTRY_LOCALE.get(code or "US", COUNTRY_LOCALE["US"])
    default_currency = normalize_currency(context.defaultCurrency) or base["currency"]
    return {
        "country": code or "US",
        "dateOrder": base["dateOrder"],
        "decimal": base["decimal"],
        "currency": default_currency,
    }


def normalize_currency(token: str) -> str:
    t = (token or "").strip().replace("(", "").replace(")", "")
    if not t:
        return ""
    if t in CURRENCY_BY_SYMBOL:
        return CURRENCY_BY_SYMBOL[t]
    up = t.upper()
    if up in CURRENCY_BY_SYMBOL:
        return CURRENCY_BY_SYMBOL[up]
    m = re.search(r"\b([A-Z]{3})\b", up)
    return m.group(1) if m else ""


def parse_localized_amount(
    raw: str,
    decimal_hint: str = ".",
    allow_negative: bool = False,
    allow_zero: bool = False,
) -> Optional[float]:
    if raw is None:
        return None
    text = re.sub(r"[^0-9,.'\-\s]", "", str(raw)).strip()
    if not text:
        return None

    has_comma = "," in text
    has_dot = "." in text
    decimal_sep = ""

    if has_comma and has_dot:
        decimal_sep = "," if text.rfind(",") > text.rfind(".") else "."
    elif has_comma:
        decimal_sep = "," if re.search(r",\d{1,2}$", text) else ("," if decimal_hint == "," else "")
    elif has_dot:
        decimal_sep = "." if re.search(r"\.\d{1,2}$", text) else ("." if decimal_hint == "." else "")

    text = text.replace(" ", "").replace("'", "")
    if decimal_sep == ",":
        text = text.replace(".", "")
        text = text.replace(",", ".")
    elif decimal_sep == ".":
        text = text.replace(",", "")
    else:
        text = text.replace(",", "").replace(".", "")

    if text.count(".") > 1:
        parts = text.split(".")
        text = "".join(parts[:-1]) + "." + parts[-1]

    try:
        value = float(text)
    except ValueError:
        return None

    if value < 0 and not allow_negative:
        return None
    if value == 0 and not allow_zero:
        return None
    if abs(value) > 1_000_000_000:
        return None
    return value


def detect_currency(text: str, fallback: str) -> str:
    patterns = [
        r"\bcurrency\s*[:\-]?\s*([A-Z]{3})\b",
        r"\(([A-Z]{3})\)",
        r"(US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[$€£¥₹])\s*\d",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if not m:
            continue
        token = m.group(1) if m.groups() else m.group(0)
        cur = normalize_currency(token)
        if cur:
            return cur
    return fallback


def parse_ymd(y: int, m: int, d: int) -> Optional[date]:
    try:
        return date(y, m, d)
    except Exception:
        return None


def parse_date_value(raw: str, date_order: str) -> Optional[date]:
    if not raw:
        return None

    value = normalize_spaces(raw)
    value = re.sub(r"\b(\d{1,2})(st|nd|rd|th)\b", r"\1", value, flags=re.IGNORECASE)
    value = re.sub(r"(?:\s+|T)\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?(?:\s*[A-Z]{2,5})?$", "", value, flags=re.IGNORECASE).strip()

    m = re.match(r"^(\d{4})[\/-\.]?(\d{1,2})[\/-\.]?(\d{1,2})$", value)
    if m:
        return parse_ymd(int(m.group(1)), int(m.group(2)), int(m.group(3)))

    m = re.match(r"^(\d{1,2})[\/-\.](\d{1,2})[\/-\.](\d{2,4})$", value)
    if m:
        a = int(m.group(1))
        b = int(m.group(2))
        y = int(m.group(3))
        if y < 100:
            y = 2000 + y if y <= 69 else 1900 + y
        if a > 12 and b <= 12:
            day, month = a, b
        elif b > 12 and a <= 12:
            day, month = b, a
        elif date_order == "DMY":
            day, month = a, b
        else:
            month, day = a, b
        return parse_ymd(y, month, day)

    m = re.match(r"^([A-Za-z]{3,20})\.?\s+(\d{1,2}),?\s+(\d{2,4})$", value)
    if m:
        mon = MONTHS.get(m.group(1).lower())
        if mon:
            y = int(m.group(3))
            if y < 100:
                y = 2000 + y if y <= 69 else 1900 + y
            return parse_ymd(y, mon, int(m.group(2)))

    m = re.match(r"^(\d{1,2})\s+([A-Za-z]{3,20})\s+(\d{2,4})$", value)
    if m:
        mon = MONTHS.get(m.group(2).lower())
        if mon:
            y = int(m.group(3))
            if y < 100:
                y = 2000 + y if y <= 69 else 1900 + y
            return parse_ymd(y, mon, int(m.group(1)))

    m = re.match(r"^(\d{1,2})[\/-\.]([A-Za-z]{3,20})[\/-\.]?(\d{2,4})$", value)
    if m:
        mon = MONTHS.get(m.group(2).lower())
        if mon:
            y = int(m.group(3))
            if y < 100:
                y = 2000 + y if y <= 69 else 1900 + y
            return parse_ymd(y, mon, int(m.group(1)))

    return None


def parse_date_range(text: str, date_order: str) -> Tuple[Optional[str], Optional[str]]:
    token = r"(?:\d{4}[\/-\.]\d{1,2}[\/-\.]\d{1,2}|\d{1,2}[\/-\.]\d{1,2}[\/-\.]\d{2,4}|\d{1,2}[\/-\.]?[A-Za-z]{3,20}[\/-\.]?\d{2,4}|[A-Za-z]{3,20}\.?\s+\d{1,2},?\s+\d{2,4}|\d{1,2}\s+[A-Za-z]{3,20}\s+\d{2,4})"
    patterns = [
        rf"service\s+(?:term|period)\s*[:\-–—]?\s*({token})\s*(?:to|through|until|till|-|–|—)\s*({token})",
        rf"billing\s+period\s*[:\-–—]?\s*({token})\s*(?:to|through|until|till|-|–|—)\s*({token})",
        rf"invoice\s+period\s*[:\-–—]?\s*({token})\s*(?:to|through|until|till|-|–|—)\s*({token})",
        rf"({token})\s*(?:to|through|until|till|-|–|—)\s*({token})",
    ]

    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if not m:
            continue
        left = parse_date_value(m.group(1), date_order)
        right = parse_date_value(m.group(2), date_order)
        if not left or not right:
            continue
        start, end = (left, right) if left <= right else (right, left)
        return start.isoformat(), end.isoformat()

    return None, None


def infer_period(period_from: Optional[str], period_to: Optional[str], text: str) -> Optional[str]:
    lower = text.lower()
    if re.search(r"\b(monthly|per\s+month)\b", lower):
        return "Monthly"
    if re.search(r"\b(quarterly|quarter)\b", lower):
        return "Quarterly"
    if re.search(r"\b(annual|annually|yearly)\b", lower):
        return "Annual"

    if period_from and period_to:
        try:
            a = date.fromisoformat(period_from)
            b = date.fromisoformat(period_to)
            days = (b - a).days
            if 27 <= days <= 34:
                return "Monthly"
            if 85 <= days <= 95:
                return "Quarterly"
            if 350 <= days <= 380:
                return "Annual"
        except Exception:
            return None
    return None


def parse_amount_with_currency(fragment: str, decimal_hint: str) -> Tuple[Optional[float], str]:
    patterns = [
        r"\(([A-Z]{3})\)\s*([0-9][0-9,.'\s-]*\d)",
        r"(US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[A-Z]{3}|[$€£¥₹])\s*([0-9][0-9,.'\s-]*\d)",
        r"([0-9][0-9,.'\s-]*\d)\s*([A-Z]{3})\b",
    ]
    for pat in patterns:
        m = re.search(pat, fragment, re.IGNORECASE)
        if not m:
            continue
        if pat.endswith("\\b"):
            amt_token, cur_token = m.group(1), m.group(2)
        else:
            cur_token, amt_token = m.group(1), m.group(2)
        amount = parse_localized_amount(amt_token, decimal_hint)
        if amount is None:
            continue
        return amount, normalize_currency(cur_token)
    return None, ""


def extract_amount(text: str, lines: List[str], decimal_hint: str) -> Tuple[Optional[float], str, float]:
    keywords = [
        ("grand total", 1.0),
        ("invoice total", 0.95),
        ("total due", 0.92),
        ("amount due", 0.9),
        ("balance due", 0.88),
        ("total", 0.72),
    ]

    candidates: List[Tuple[float, str, float]] = []
    for idx, line in enumerate(lines):
        low = line.lower()
        for key, conf in keywords:
            if key not in low:
                continue
            amount, cur = parse_amount_with_currency(line, decimal_hint)
            if amount is not None:
                candidates.append((amount, cur, conf))
                break
            if idx + 1 < len(lines):
                amount2, cur2 = parse_amount_with_currency(f"{line} {lines[idx + 1]}", decimal_hint)
                if amount2 is not None:
                    candidates.append((amount2, cur2, max(conf - 0.08, 0.5)))
                    break

    if candidates:
        candidates.sort(key=lambda x: x[2], reverse=True)
        return candidates[0]

    fallback_amount, fallback_currency = parse_amount_with_currency(text, decimal_hint)
    if fallback_amount is not None:
        return fallback_amount, fallback_currency, 0.55

    return None, "", 0.0


def extract_license_quantity(text: str, lines: List[str]) -> Tuple[Optional[int], float]:
    probes = [
        r"(?:qty|quantity|license\s*quantity|licenses?\s*ordered|licenses?|licences?|seats?|users?)\s*[:\-]?\s*([0-9][0-9,\.\s]*)",
        r"([0-9][0-9,\.\s]*)\s*(?:licenses?|licences?|seats?|users?)\b",
    ]

    for idx, line in enumerate(lines):
        if not re.search(r"qty|quantity|license|licence|seat|user", line, re.IGNORECASE):
            continue
        for probe in probes:
            m = re.search(probe, line, re.IGNORECASE)
            if not m:
                continue
            token = re.sub(r"[^0-9]", "", m.group(1))
            if not token:
                continue
            value = int(token)
            if 0 < value <= 500000:
                return value, 0.85

        # Multiline fallback for table/header layouts:
        # current line has quantity label, next line has numeric value.
        if idx + 1 < len(lines):
            nxt = lines[idx + 1]
            m2 = re.search(r"\b([0-9][0-9,\.\s]*)\b", nxt)
            if m2:
                token2 = re.sub(r"[^0-9]", "", m2.group(1))
                if token2:
                    value2 = int(token2)
                    if 0 < value2 <= 500000:
                        return value2, 0.78

    for probe in probes:
        m = re.search(probe, text, re.IGNORECASE)
        if not m:
            continue
        token = re.sub(r"[^0-9]", "", m.group(1))
        if not token:
            continue
        value = int(token)
        if 0 < value <= 500000:
            return value, 0.65

    # Compact unit-token rows (e.g. "...Pro8EA23.99...")
    unit_probe = r"([0-9]{1,5})\s*(?:EA|EACH|SEATS?|USERS?|LIC(?:ENSE)?S?)(?=[^A-Za-z]|$)"
    for line in lines:
        m = re.search(unit_probe, line, re.IGNORECASE)
        if not m:
            continue
        token = re.sub(r"[^0-9]", "", m.group(1))
        if not token:
            continue
        value = int(token)
        if 0 < value <= 500000:
            return value, 0.74

    m_flat = re.search(unit_probe, text, re.IGNORECASE)
    if m_flat:
        token_flat = re.sub(r"[^0-9]", "", m_flat.group(1))
        if token_flat:
            value_flat = int(token_flat)
            if 0 < value_flat <= 500000:
                return value_flat, 0.7

    return None, 0.0


def extract_license_unit_price(text: str, lines: List[str], decimal_hint: str) -> Tuple[Optional[float], float]:
    probe = re.compile(r"unit\s*price|price\s*per\s*(?:user|seat|license)|license\s*price|seat\s*price|rate", re.IGNORECASE)
    for line in lines:
        if not probe.search(line):
            continue
        amount, _cur = parse_amount_with_currency(line, decimal_hint)
        if amount is not None:
            return amount, 0.82

    inline = re.search(r"([A-Z]{3}|US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[$€£¥₹])?\s*([0-9][0-9,.'\s-]*\d)\s*(?:\/|per)\s*(?:user|seat|license)", text, re.IGNORECASE)
    if inline:
        amount = parse_localized_amount(inline.group(2), decimal_hint)
        if amount is not None:
            return amount, 0.74

    return None, 0.0


def extract_subscription_plan(text: str, lines: List[str]) -> Tuple[Optional[str], float]:
    probes = [
        r"(?:subscription\s*plan|plan|edition|package|tier)\s*[:\-]\s*([^\n]+)",
        r"(?:selected|current)\s*plan\s*[:\-]\s*([^\n]+)",
    ]

    def clean(value: str) -> str:
        v = normalize_spaces(value)
        if not v or len(v) > 80:
            return ""
        if re.search(r"\d{3,}", v) and re.search(r"[$€£¥₹]", v):
            return ""
        return v

    for line in lines:
        for p in probes:
            m = re.search(p, line, re.IGNORECASE)
            if not m:
                continue
            val = clean(m.group(1))
            if val:
                return val, 0.78

    for p in probes:
        m = re.search(p, text, re.IGNORECASE)
        if not m:
            continue
        val = clean(m.group(1))
        if val:
            return val, 0.6

    return None, 0.0


def parse_amount_tokens(fragment: str, decimal_hint: str) -> List[float]:
    token_pattern = re.compile(
        r"-?\s*(?:US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[$€£¥₹])?\s*[0-9][0-9,.'\s-]{0,24}\d",
        re.IGNORECASE,
    )
    values: List[float] = []
    for match in token_pattern.finditer(fragment or ""):
        raw_token = match.group(0)
        has_currency = bool(re.search(r"(?:US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[$€£¥₹]|\b[A-Z]{3}\b)", raw_token, re.IGNORECASE))
        has_decimal = bool(re.search(r"(?:\.\d{1,2}\b|,\d{2}\b)", raw_token))
        has_grouping = ("," in raw_token) or ("'" in raw_token)
        if not (has_currency or has_decimal or has_grouping):
            continue

        val = parse_localized_amount(
            raw_token,
            decimal_hint,
            allow_negative=True,
            allow_zero=True,
        )
        if val is None:
            continue
        values.append(round(val, 2))
    return values


def extract_amount_after_label(text: str, label_pattern: str, decimal_hint: str) -> Optional[float]:
    values: List[float] = []
    for match in re.finditer(label_pattern, text or "", re.IGNORECASE):
        tail = (text or "")[match.end(): match.end() + 140]
        nums = parse_amount_tokens(tail, decimal_hint)
        if nums:
            values.append(nums[0])
    if not values:
        return None
    return values[-1]


def extract_charge_line_items(text: str, decimal_hint: str) -> List[ParsedLineItem]:
    if not re.search(r"charge\s+name\s*:", text or "", re.IGNORECASE):
        return []

    split_pattern = re.compile(r"(?=charge\s+name\s*:)", re.IGNORECASE)
    sections = split_pattern.split(text or "")
    items: List[ParsedLineItem] = []

    for sec in sections:
        if not re.search(r"charge\s+name\s*:", sec, re.IGNORECASE):
            continue

        end = re.search(
            r"(?:invoice\s+balance|total\s*\(\s*including|total\s+including\s+taxes|^\s*subtotal\b)",
            sec,
            re.IGNORECASE,
        )
        body = sec[: end.start()] if end else sec

        name_match = re.search(
            r"charge\s+name\s*:\s*(.+?)(?=(?:quantity\s*:|unit\s*price\s*:|billing\s*period|$))",
            body,
            re.IGNORECASE | re.DOTALL,
        )
        name = normalize_spaces(name_match.group(1)) if name_match else ""

        qty_match = re.search(r"quantity\s*:\s*(-?\d+)", body, re.IGNORECASE)
        quantity = int(qty_match.group(1)) if qty_match else None

        unit_match = re.search(r"unit\s*price\s*:\s*([^,\n;]+)", body, re.IGNORECASE)
        unit_price = (
            parse_localized_amount(unit_match.group(1), decimal_hint, allow_negative=True, allow_zero=True)
            if unit_match
            else None
        )

        amounts = parse_amount_tokens(body, decimal_hint)
        if unit_price is not None and amounts:
            pruned: List[float] = []
            removed = False
            for val in amounts:
                if not removed and abs(val - unit_price) < 0.01:
                    removed = True
                    continue
                pruned.append(val)
            amounts = pruned

        subtotal = None
        taxes = None
        total = None
        if len(amounts) >= 3:
            subtotal = amounts[0]
            taxes = amounts[1]
            total = amounts[2]
        elif len(amounts) == 2:
            subtotal = amounts[0]
            total = amounts[1]
        elif len(amounts) == 1:
            total = amounts[0]

        kind = "charge"
        low_name = (name or "").lower()
        if re.search(r"\bcredit|refund|reversal|adjustment\b", low_name, re.IGNORECASE):
            kind = "credit"
        elif re.search(r"\bpay[\s-]?as[\s-]?you[\s-]?go|usage[-\s]?based|metered\b", low_name, re.IGNORECASE):
            kind = "usage"

        if not name and quantity is None and unit_price is None and subtotal is None and taxes is None and total is None:
            continue

        items.append(
            ParsedLineItem(
                name=name,
                quantity=quantity,
                unitPrice=round(unit_price, 2) if unit_price is not None else None,
                subtotal=subtotal,
                taxes=taxes,
                total=total,
                kind=kind,
            )
        )

    return items


def is_prorated_line_name(name: str) -> bool:
    low = (name or "").lower()
    return bool(
        re.search(r"\bpro[\s-]?rat(?:ed|ion)\b", low, re.IGNORECASE)
        or re.search(r"\btrue[-\s]?up\b", low, re.IGNORECASE)
        or re.search(r"\bpartial\s+(?:month|period)\b", low, re.IGNORECASE)
        or re.search(r"\badjustment\b", low, re.IGNORECASE)
        or re.search(r"\bcredit\b", low, re.IGNORECASE)
    )


def summarize_non_prorated_seat_lines(line_items: List[ParsedLineItem]) -> Dict[str, Any]:
    positive_charge_rows = [
        li for li in (line_items or [])
        if (li.kind or "other").lower() != "credit"
    ]
    seat_rows: List[ParsedLineItem] = []
    for li in positive_charge_rows:
        name = (li.name or "").lower()
        if is_prorated_line_name(name):
            continue
        looks_seat_name = bool(re.search(r"\b(seat|license|licensed|user|member|editor|viewer|full\s*seat|dev\s*seat)\b", name, re.IGNORECASE))
        has_numeric_pair = li.quantity is not None and li.quantity > 0 and li.unitPrice is not None and li.unitPrice > 0
        if looks_seat_name or has_numeric_pair:
            seat_rows.append(li)

    enriched: List[Dict[str, Any]] = []
    for idx, li in enumerate(seat_rows):
        enriched.append({
            "_idx": idx,
            "name": normalize_spaces(li.name or "") or f"Service {idx + 1}",
            "quantity": int(li.quantity) if li.quantity is not None and li.quantity > 0 else None,
            "unitPrice": float(li.unitPrice) if li.unitPrice is not None and li.unitPrice > 0 else None,
            "subtotal": float(li.subtotal) if li.subtotal is not None else None,
            "total": float(li.total) if li.total is not None else None,
        })

    primary_line = None
    if enriched:
        primary_line = sorted(
            enriched,
            key=lambda row: (
                -(row.get("quantity") or 0),
                -(row.get("total") or row.get("subtotal") or 0),
                row.get("_idx", 0),
            ),
        )[0]

    additional_lines = [row for row in enriched if primary_line and row.get("_idx") != primary_line.get("_idx")]

    quantities = [int(row["quantity"]) for row in enriched if row.get("quantity") is not None and row.get("quantity") > 0]
    total_qty = int(sum(quantities)) if quantities else 0

    weighted_numerator = 0.0
    weighted_denominator = 0
    for row in enriched:
        q = row.get("quantity")
        u = row.get("unitPrice")
        if q is None or q <= 0 or u is None or u <= 0:
            continue
        weighted_numerator += float(q) * float(u)
        weighted_denominator += int(q)
    blended_unit_price = (weighted_numerator / weighted_denominator) if weighted_denominator > 0 else None

    distinct_units = sorted({
        round(float(li.unitPrice), 4)
        for li in enriched
        if li.get("unitPrice") is not None and li.get("unitPrice") > 0
    })

    return {
        "primary_line": primary_line,
        "primary_qty": int(primary_line["quantity"]) if primary_line and primary_line.get("quantity") else 0,
        "primary_unit_price": float(primary_line["unitPrice"]) if primary_line and primary_line.get("unitPrice") else None,
        "primary_name": str(primary_line.get("name", "")) if primary_line else "",
        "additional_lines": additional_lines,
        "quantities": quantities,
        "total_qty": total_qty,
        "line_count": len(enriched),
        "blended_unit_price": blended_unit_price,
        "has_mixed_units": len(distinct_units) > 1,
    }


def detect_invoice_complexity(text: str, lines: List[str]) -> Tuple[bool, bool, List[str]]:
    lower = (text or "").lower()
    reasons: List[str] = []

    prorated_patterns = [
        r"\bpro[\s-]?rat(?:ed|ion)\b",
        r"\bpartial\s+(?:month|period)\b",
        r"\btrue[-\s]?up\b",
        r"\bcredit\s+memo\b",
        r"\bcarry[-\s]?forward\b",
        r"\bmid[-\s]?cycle\b",
    ]
    is_prorated = any(re.search(p, lower, re.IGNORECASE) for p in prorated_patterns)
    if is_prorated:
        reasons.append("prorated or adjustment terms detected")

    usage_patterns = [
        r"\bpay[\s-]?as[\s-]?you[\s-]?go\b",
        r"\busage[-\s]?based\b",
        r"\bmetered\b",
    ]
    is_usage_based = any(re.search(p, lower, re.IGNORECASE) for p in usage_patterns)
    if is_usage_based:
        reasons.append("usage-based charge detected")

    line_markers = r"\b(plan|subscription|license|seat|user|add[-\s]?on|service|package|bundle)\b"
    line_item_rows = [
        ln for ln in (lines or [])
        if re.search(line_markers, ln, re.IGNORECASE)
        and re.search(r"(?:[$€£¥₹]|US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|\b[A-Z]{3}\b)?\s*\d+[,\d]*(?:\.\d{1,2})?", ln)
    ]
    money_tokens = re.findall(
        r"(?:US\$|C\$|A\$|NZ\$|S\$|HK\$|R\$|MX\$|[$€£¥₹]|\b[A-Z]{3}\b)\s*[0-9][0-9,.'\s-]{0,20}\d",
        text or "",
        re.IGNORECASE,
    )
    has_multi_markers = bool(re.search(r"\b(add[-\s]?on|line\s+items?|bundle|package)\b", lower, re.IGNORECASE))

    # Keep multi-subscription detection conservative to avoid false positives
    # from normal single-plan invoices that still include subtotal/tax/total rows.
    has_multiple_subscriptions = has_multi_markers or len(line_item_rows) >= 2 or len(money_tokens) >= 6
    if has_multiple_subscriptions:
        reasons.append("multiple subscription or line-item charges detected")

    return is_prorated, has_multiple_subscriptions, reasons


def extract_text_pdf(buffer: bytes) -> str:
    with io.BytesIO(buffer) as bio:
        reader = PdfReader(bio)
        chunks = []
        for page in reader.pages:
            chunks.append(page.extract_text() or "")
        return "\n".join(chunks)


def extract_text_ocr(buffer: bytes, warnings: List[str]) -> str:
    ocr_enabled = os.getenv("OCR_ENABLED", "true").lower() in ("1", "true", "yes", "on")
    if not ocr_enabled:
        warnings.append("OCR disabled")
        return ""

    max_pages = max(1, int(os.getenv("OCR_MAX_PAGES", "3")))

    try:
        import pypdfium2 as pdfium  # type: ignore
        import pytesseract  # type: ignore
    except Exception:
        warnings.append("OCR libraries not installed")
        return ""

    try:
        pdf = pdfium.PdfDocument(buffer)
        pages = min(len(pdf), max_pages)
        texts: List[str] = []
        for i in range(pages):
            page = pdf[i]
            bitmap = page.render(scale=2.0)
            pil_image = bitmap.to_pil()
            text = pytesseract.image_to_string(pil_image)
            if text:
                texts.append(text)
        return "\n".join(texts)
    except Exception as err:
        warnings.append(f"OCR failed: {err}")
        return ""


def run_parser(buffer: bytes, context: ParseContext) -> ParseResponse:
    warnings: List[str] = []

    text_pdf = (extract_text_pdf(buffer) or "").strip()

    ocr_text = ""
    if len(normalize_spaces(text_pdf)) < 40:
        ocr_text = (extract_text_ocr(buffer, warnings) or "").strip()

    source = "text"
    combined_raw = text_pdf
    if ocr_text and text_pdf:
        source = "hybrid"
        combined_raw = f"{text_pdf}\n{ocr_text}"
    elif ocr_text and not text_pdf:
        source = "ocr"
        combined_raw = ocr_text

    lines = [normalize_spaces(x) for x in re.split(r"\r?\n", combined_raw) if normalize_spaces(x)]
    if not lines:
        fallback_line = normalize_spaces(combined_raw)
        lines = [fallback_line] if fallback_line else []
    combined = "\n".join(lines)
    flat_text = normalize_spaces(combined)

    if not flat_text:
        return ParseResponse(
            amount=None,
            currency=context.defaultCurrency or "USD",
            confidence="low",
            needsReview=True,
            source=source,
            warnings=warnings + ["No readable text extracted from document"],
            fieldConfidence={},
            raw="",
            rawFull="",
        )

    locale = resolve_locale(context, flat_text)

    amount, amount_currency, amount_conf = extract_amount(flat_text, lines, locale["decimal"])
    currency = detect_currency(flat_text, amount_currency or locale["currency"])

    period_from, period_to = parse_date_range(flat_text, locale["dateOrder"])
    period = infer_period(period_from, period_to, flat_text)

    qty, qty_conf = extract_license_quantity(flat_text, lines)
    unit_price, unit_conf = extract_license_unit_price(flat_text, lines, locale["decimal"])
    plan, plan_conf = extract_subscription_plan(flat_text, lines)
    line_items = extract_charge_line_items(combined, locale["decimal"])
    subtotal_value = extract_amount_after_label(flat_text, r"\bsubtotal\b", locale["decimal"])
    tax_total_value = extract_amount_after_label(flat_text, r"(?:taxes?,?\s*fees?\s*&?\s*surcharges?)", locale["decimal"])
    total_including_taxes = extract_amount_after_label(
        flat_text,
        r"total\s*(?:\(\s*including\s+taxes?,?\s*fees?\s*&?\s*surcharges?\s*\)|including\s+taxes?,?\s*fees?\s*&?\s*surcharges?)",
        locale["decimal"],
    )
    invoice_balance = extract_amount_after_label(flat_text, r"invoice\s+balance", locale["decimal"])

    if total_including_taxes is not None and total_including_taxes > 0:
        amount = total_including_taxes
        amount_conf = max(amount_conf, 0.95)
    elif amount is None and subtotal_value is not None and subtotal_value > 0:
        amount = subtotal_value
        amount_conf = max(amount_conf, 0.78)

    is_prorated, has_multiple_subscriptions, complexity_reasons = detect_invoice_complexity(flat_text, lines)
    if len(line_items) >= 2 and not has_multiple_subscriptions:
        has_multiple_subscriptions = True
        complexity_reasons = complexity_reasons + ["multiple parsed charge rows detected"]

    seat_summary = summarize_non_prorated_seat_lines(line_items)
    primary_seat_qty = int(seat_summary.get("primary_qty") or 0)
    seat_quantities = [int(v) for v in (seat_summary.get("quantities") or []) if isinstance(v, int) and v > 0]
    primary_unit_price = seat_summary.get("primary_unit_price")
    blended_unit_price = seat_summary.get("blended_unit_price")
    primary_plan_name = normalize_spaces(str(seat_summary.get("primary_name") or ""))

    if primary_seat_qty > 0:
        if seat_summary.get("line_count", 0) >= 2:
            should_adjust = (
                qty is None
                or qty in seat_quantities
                or qty > primary_seat_qty
                or qty == int(seat_summary.get("total_qty") or 0)
            )
            if should_adjust:
                if qty is not None and qty != primary_seat_qty:
                    warnings = warnings + [
                        f"Adjusted license quantity {qty} -> {primary_seat_qty} using primary non-prorated seat row"
                    ]
                qty = primary_seat_qty
                qty_conf = max(qty_conf, 0.84)
        elif qty is None:
            qty = primary_seat_qty
            qty_conf = max(qty_conf, 0.78)

    preferred_unit_price = None
    if primary_unit_price is not None and primary_unit_price > 0:
        preferred_unit_price = float(primary_unit_price)
    elif blended_unit_price is not None and blended_unit_price > 0:
        preferred_unit_price = float(blended_unit_price)

    if preferred_unit_price is not None:
        should_replace_unit = unit_price is None
        if is_prorated and unit_price is not None:
            diff_ratio = abs(float(unit_price) - float(preferred_unit_price)) / float(preferred_unit_price)
            if diff_ratio > 0.1:
                should_replace_unit = True
        if should_replace_unit:
            unit_price = float(preferred_unit_price)
            unit_conf = max(unit_conf, 0.8 if seat_summary.get("line_count", 0) >= 2 else 0.74)

    if seat_summary.get("line_count", 0) >= 2:
        if seat_summary.get("has_mixed_units"):
            warnings = warnings + ["Multiple non-prorated seat unit prices detected; primary service price used"]
        else:
            warnings = warnings + ["Multiple non-prorated services detected; secondary services kept separate"]

    if not plan and primary_plan_name:
        plan = primary_plan_name
        plan_conf = max(plan_conf, 0.8 if seat_summary.get("line_count", 0) >= 2 else 0.72)

    field_conf: Dict[str, float] = {
        "amount": round(amount_conf, 2),
        "currency": 0.95 if currency else 0.0,
        "periodFrom": 0.88 if period_from else 0.0,
        "periodTo": 0.88 if period_to else 0.0,
        "billingPeriod": 0.9 if period else 0.0,
        "licenseQuantity": round(qty_conf, 2),
        "licenseUnitPrice": round(unit_conf, 2),
        "subscriptionPlan": round(plan_conf, 2),
    }

    hits = sum(
        1
        for k in ["amount", "currency", "periodFrom", "periodTo", "billingPeriod", "licenseQuantity", "licenseUnitPrice", "subscriptionPlan"]
        if field_conf.get(k, 0.0) >= 0.7
    )

    if hits >= 5:
        confidence = "high"
    elif hits >= 3:
        confidence = "medium"
    else:
        confidence = "low"

    if complexity_reasons:
        if confidence == "high":
            confidence = "medium"
        elif confidence == "medium":
            confidence = "low"
        warnings = warnings + [f"Complex invoice detected: {', '.join(complexity_reasons)}"]

    needs_review = confidence != "high" or amount is None or bool(complexity_reasons)

    return ParseResponse(
        amount=round(amount, 2) if amount is not None else None,
        currency=currency or locale["currency"],
        billingPeriod=period,
        periodFrom=period_from,
        periodTo=period_to,
        licenseQuantity=qty,
        licenseUnitPrice=round(unit_price, 2) if unit_price is not None else None,
        subscriptionPlan=plan,
        renewalPeriod=period,
        confidence=confidence,
        fieldConfidence=field_conf,
        needsReview=needs_review,
        source=source,
        warnings=warnings,
        subtotal=round(subtotal_value, 2) if subtotal_value is not None else None,
        taxTotal=round(tax_total_value, 2) if tax_total_value is not None else None,
        totalIncludingTaxes=round(total_including_taxes, 2) if total_including_taxes is not None else None,
        invoiceBalance=round(invoice_balance, 2) if invoice_balance is not None else None,
        lineItems=line_items,
        isProrated=is_prorated,
        hasMultipleSubscriptions=has_multiple_subscriptions,
        complexityReasons=complexity_reasons,
        localeCountry=locale["country"],
        dateOrder=locale["dateOrder"],
        raw=flat_text[:500],
        rawFull=flat_text[:20000],
    )


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "invoice-parser", "ts": datetime.utcnow().isoformat() + "Z"}


# ── /extract-regions — extract text from annotated bounding boxes ─────────────
class RegionCoord(BaseModel):
    x: float        # 0–1 (fraction of page width)
    y: float        # 0–1 (fraction of page height)
    w: float
    h: float
    page: int = 1   # 1-indexed

class ExtractRegionsRequest(BaseModel):
    fileBase64: Optional[str] = None
    data:       Optional[str] = None
    regions:    Dict[str, RegionCoord] = Field(default_factory=dict)  # fieldKey → coord

class ExtractRegionsResponse(BaseModel):
    values:   Dict[str, str] = Field(default_factory=dict)   # fieldKey → extracted text
    warnings: List[str]      = Field(default_factory=list)

@app.post("/extract-regions", response_model=ExtractRegionsResponse)
def extract_regions(req: ExtractRegionsRequest) -> ExtractRegionsResponse:
    """
    Given a PDF and a map of field→bounding-box coordinates (0–1 fractions),
    extract the text inside each bounding box using pdfplumber.
    Falls back to pytesseract OCR if pdfplumber returns empty text.
    """
    payload = req.fileBase64 or req.data or ""
    warnings: List[str] = []

    if not payload:
        return ExtractRegionsResponse(warnings=["fileBase64/data is required"])

    data_str = re.sub(r"^data:[^;]+;base64,", "", payload)
    try:
        buffer = base64.b64decode(data_str, validate=False)
    except Exception:
        return ExtractRegionsResponse(warnings=["Invalid base64 payload"])

    values: Dict[str, str] = {}

    try:
        import pdfplumber  # type: ignore
    except ImportError:
        warnings.append("pdfplumber not installed — falling back to text extraction")
        return ExtractRegionsResponse(values=values, warnings=warnings)

    try:
        with pdfplumber.open(io.BytesIO(buffer)) as pdf:
            for field_key, coord in req.regions.items():
                page_idx = max(0, (coord.page or 1) - 1)
                if page_idx >= len(pdf.pages):
                    warnings.append(f"{field_key}: page {coord.page} not found")
                    values[field_key] = ""
                    continue

                page = pdf.pages[page_idx]
                pw, ph = float(page.width), float(page.height)

                # Convert 0–1 fractions → absolute points
                x0 = coord.x * pw
                y0 = coord.y * ph
                x1 = (coord.x + coord.w) * pw
                y1 = (coord.y + coord.h) * ph

                # Add small padding for robustness
                pad = 2
                crop = page.crop((
                    max(0, x0 - pad),
                    max(0, y0 - pad),
                    min(pw, x1 + pad),
                    min(ph, y1 + pad),
                ))
                text = (crop.extract_text() or "").strip()

                # If pdfplumber returns nothing, the region may be image-based — try OCR
                if not text:
                    try:
                        import pypdfium2 as pdfium  # type: ignore
                        import pytesseract           # type: ignore
                        from PIL import Image        # type: ignore

                        doc  = pdfium.PdfDocument(buffer)
                        pg   = doc[page_idx]
                        scale = 3.0  # high-res for small crops
                        bmp  = pg.render(scale=scale)
                        img  = bmp.to_pil()

                        # Crop to region in pixel space
                        iw, ih = img.size
                        ix0 = int(coord.x * iw)
                        iy0 = int(coord.y * ih)
                        ix1 = int((coord.x + coord.w) * iw)
                        iy1 = int((coord.y + coord.h) * ih)
                        crop_img = img.crop((
                            max(0, ix0 - 4), max(0, iy0 - 4),
                            min(iw, ix1 + 4), min(ih, iy1 + 4),
                        ))
                        text = pytesseract.image_to_string(crop_img, config="--psm 7").strip()
                    except Exception as ocr_err:
                        warnings.append(f"{field_key}: OCR fallback failed — {ocr_err}")

                values[field_key] = text

    except Exception as e:
        warnings.append(f"pdfplumber extraction failed: {e}")

    return ExtractRegionsResponse(values=values, warnings=warnings)


@app.post("/parse-invoice", response_model=ParseResponse)
def parse_invoice(req: ParseRequest) -> ParseResponse:
    payload = req.fileBase64 or req.data or ""
    if not payload:
        return ParseResponse(
            amount=None,
            currency=req.context.defaultCurrency or "USD",
            confidence="low",
            needsReview=True,
            source="text",
            warnings=["fileBase64/data is required"],
            fieldConfidence={},
            raw="",
            rawFull="",
        )

    data_str = re.sub(r"^data:[^;]+;base64,", "", payload)
    try:
        buffer = base64.b64decode(data_str, validate=False)
    except Exception:
        return ParseResponse(
            amount=None,
            currency=req.context.defaultCurrency or "USD",
            confidence="low",
            needsReview=True,
            source="text",
            warnings=["Invalid base64 payload"],
            fieldConfidence={},
            raw="",
            rawFull="",
        )

    return run_parser(buffer, req.context)
