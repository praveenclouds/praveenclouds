# Invoice Parser Service (Python)

This project now supports a dedicated Python invoice parser service with OCR fallback.

## Service
- Container: `invoice-parser`
- Base URL inside Docker network: `http://invoice-parser:8001`
- Health endpoint: `GET /health`
- Parse endpoint: `POST /parse-invoice`

## Request Contract
```json
{
  "fileBase64": "data:application/pdf;base64,...",
  "fileName": "Invoice_7236290439_INVOICE.pdf",
  "mimeType": "application/pdf",
  "context": {
    "billingAddress": "India",
    "countryCode": "IN",
    "countryHints": ["IN", "India"],
    "defaultCurrency": "INR"
  }
}
```

## Response Contract
```json
{
  "amount": 191.92,
  "currency": "USD",
  "billingPeriod": "Monthly",
  "periodFrom": "2026-03-24",
  "periodTo": "2026-04-23",
  "licenseQuantity": 7,
  "licenseUnitPrice": 22.67,
  "subscriptionPlan": "Business Plan",
  "renewalPeriod": "Monthly",
  "confidence": "high",
  "fieldConfidence": {
    "amount": 0.96,
    "currency": 0.95,
    "periodFrom": 0.92
  },
  "needsReview": false,
  "source": "text",
  "warnings": [],
  "localeCountry": "IN",
  "dateOrder": "DMY",
  "raw": "..."
}
```

## Node Integration
`/api/software/parse-invoice` in Node now:
1. Tries Python parser if `INVOICE_PARSER_URL` is set.
2. Falls back to JS parser (`utils/invoice-parser.js`) if Python times out/errors.

## Environment Variables
- `INVOICE_PARSER_URL` (Node app)
- `INVOICE_PARSER_TIMEOUT_MS` (Node app, default `30000`)
- `OCR_ENABLED` (Python service)
- `OCR_MAX_PAGES` (Python service, default `3`)

## Notes
- OCR uses `pytesseract` and `tesseract-ocr`.
- OCR fallback is used when extracted PDF text is very low.
