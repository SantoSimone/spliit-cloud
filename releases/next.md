Welcome to `vNEXT`! One or two sentences on what this release is about.

## Highlights

- Headline one

### Headline one

A short paragraph per headline, with a screenshot where it helps.

![caption](./assets/next/shot.webp)

## What's Changed

### 🚨 Breaking Changes

Omit this section when there are none. Each entry names what breaks,
who is affected, and the exact migration steps.

- Item quantities are stored as milli-units: existing quantities migrate automatically (`2` → `2000`), pre-upgrade export backups scale on import, and webhook `quantity` values now read in thousandths (`1500` means 1.5 items — see the webhook docs). An outdated app tab that tries to save is stopped with a refresh prompt instead of writing a wrong quantity. (`TBD` by @TBD)

### 🚀 Features

- Short entry per user-facing change (`TBD` by @TBD)
- Optional dedicated OCR backend for receipt scans: set `AI_OCR_PROVIDER=ocrspace` (plus `AI_OCRSPACE_API_KEY`) to extract receipt text via OCR.space and structure it with a fast text-only model call instead of the vision LLM, with automatic fallback to the vision scan when OCR fails. Scans that find nothing now say so explicitly and keep the photo attached for manual entry. (`TBD` by @TBD)
- Scan receipts from PDFs and documents: AI receipt scan now accepts PDF invoices plus TXT, CSV, DOCX, and ODT files alongside photos. Digital documents extract their text directly; scanned-image PDFs fall back to OCR or the vision model. (`TBD` by @TBD)
- Receipt line items now render as a structured list with line totals: the AI scan preview and saved expenses share the same rows, with a `qty × unit price` sub-line only when the quantity isn't 1 and a show-more toggle for long receipts. (`TBD` by @TBD)
- More reliable receipt line items: the scanner now returns prices and quantities as exact integers (no more decimal drift), joins item details split across adjacent receipt lines, and double-checks easily confused digits (like 0 vs 8) against the printed line totals. (`TBD` by @TBD)
- Fractional item quantities: quantities accept up to 3 decimals (for example `1.5` kg), whole numbers still display and type as whole, and the receipt scanner captures the true fractional quantity when the receipt shows one. (`TBD` by @TBD)
- Clearer receipt total mismatches: when scanned items don't add up to the receipt total, the preview asks which total is correct — cent-size gaps offer the choice immediately (receipt total preselected, with a "Rounding" line), while larger gaps warn they look bigger than rounding and offer an explicit "Other" (or "Other (excess)") line instead. (`TBD` by @TBD)

### 🐛 Bug fixes

- Short entry per fix (`TBD` by @TBD)
- Fixed AI receipt scans and expense-document uploads failing with `CORS Missing Allow Origin`: the local MaxIO bucket now allows all local web origins, and self-hosters get documented S3 CORS requirements. (`TBD` by @TBD)
- Fixed a single failing request (for example an AI receipt scan error) wrongly triggering the "Spliit Cloud can't be reached" downtime banner: the banner now appears only when the server is actually unreachable or its health check fails, while request errors show inline where they happened. (`TBD` by @TBD)
- AI receipt review now flags when scanned line items don't add up to the receipt total (taxes and fees are excluded from items by design) and pre-checks a "Rounding" line for the difference, so itemized expenses match the charged total. Unchecking it shows an error and leaves the fix to the edit form. (`TBD` by @TBD)

**Full Changelog**: TBD
