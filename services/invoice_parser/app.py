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
    localeCountry: str = "US"
    dateOrder: str = "MDY"
    raw: str = ""


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


def parse_localized_amount(raw: str, decimal_hint: str = ".") -> Optional[float]:
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

    if value <= 0 or value > 1_000_000_000:
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

    text_pdf = extract_text_pdf(buffer)
    text_pdf = normalize_spaces(text_pdf)

    ocr_text = ""
    if len(text_pdf) < 40:
        ocr_text = normalize_spaces(extract_text_ocr(buffer, warnings))

    source = "text"
    combined = text_pdf
    if ocr_text and text_pdf:
        source = "hybrid"
        combined = normalize_spaces(f"{text_pdf}\n{ocr_text}")
    elif ocr_text and not text_pdf:
        source = "ocr"
        combined = ocr_text

    if not combined:
        return ParseResponse(
            amount=None,
            currency=context.defaultCurrency or "USD",
            confidence="low",
            needsReview=True,
            source=source,
            warnings=warnings + ["No readable text extracted from document"],
            fieldConfidence={},
            raw="",
        )

    locale = resolve_locale(context, combined)
    lines = [normalize_spaces(x) for x in re.split(r"\r?\n", combined) if normalize_spaces(x)]

    amount, amount_currency, amount_conf = extract_amount(combined, lines, locale["decimal"])
    currency = detect_currency(combined, amount_currency or locale["currency"])

    period_from, period_to = parse_date_range(combined, locale["dateOrder"])
    period = infer_period(period_from, period_to, combined)

    qty, qty_conf = extract_license_quantity(combined, lines)
    unit_price, unit_conf = extract_license_unit_price(combined, lines, locale["decimal"])
    plan, plan_conf = extract_subscription_plan(combined, lines)

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

    needs_review = confidence != "high" or amount is None

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
        localeCountry=locale["country"],
        dateOrder=locale["dateOrder"],
        raw=combined[:500],
    )


@app.get("/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "invoice-parser", "ts": datetime.utcnow().isoformat() + "Z"}


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
        )

    return run_parser(buffer, req.context)
