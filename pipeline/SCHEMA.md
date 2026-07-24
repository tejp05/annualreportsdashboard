# Standardized dataset schema

The pipeline turns 116 IBM/CTR annual-report PDFs (fiscal years **1911–2025**)
into auditable, machine-readable data for the dashboard. Everything is keyed by
**fiscal year** (integer). Money is stored in **US$ millions** (raw, as reported)
so no precision is lost; the website can scale to billions for display.

## Files (in `pipeline/data/`)

| File | What |
|------|------|
| `financials.json` | Canonical per-year financial time series (one object per fiscal year). |
| `financials.csv`  | Same data, flat, for spreadsheets / quick charting. |
| `segments.json`   | Revenue/profit by reporting segment & geography (modern era, where reported). |
| `metadata.json`   | Per-report qualitative data: chairman/CEO, theme, key milestones, page map. |
| `provenance.json` | For every numeric cell: which report, page, parser, and any cross-check note. |
| `validation.json` | Cross-report overlap checks + flags for figures that disagree. |

## `financials.json` — one object per year

```jsonc
{
  "year": 2024,
  "currency": "USD_millions",
  "revenue":            62753,   // total revenue / gross income
  "netIncome":          6023,    // net income attributable to IBM (total, incl. disc. ops)
  "grossProfit":        null,
  "rdExpense":          7479,    // research, development & engineering
  "operatingIncome":    null,
  "pretaxIncome":       null,
  "totalAssets":        137175,
  "totalLiabilities":   null,
  "stockholdersEquity": 27393,
  "longTermDebt":       null,
  "totalDebt":          null,
  "cashAndEquivalents": null,
  "capitalExpenditure": null,
  "epsBasic":           6.53,    // total per share (incl. disc. ops)
  "epsDiluted":         6.43,
  "dividendsPerShare":  null,
  "sharesOutstandingM": 937.16,  // weighted avg diluted, millions
  "employees":          null,
  "basis":   "revenue=worldwide consolidated revenue; ...",  // per-cell basis notes
  "flags":   []                  // e.g. ["ocr-verified", "disagreement"]
}
```

`null` is common and intentional — a metric is only present where a filing
actually reports it. **Coverage as of the latest build** (years with a value):

| metric | years | span |
|--------|------:|------|
| `netIncome` | 115 | 1911–2025 (continuous) |
| `revenue` | 86 | 1940–2025 (pre-1923 CTR reports state net profit, not revenue) |
| `epsDiluted` / `epsBasic` | 53 | 1970–2025 |
| `totalAssets` | 43 | 1978–2024 |
| `stockholdersEquity` | 42 | 1978–2024 |
| `dividendsPerShare` | 38 | 1980–2017 (5-yr tables dropped the per-share row after 2017) |
| `rdExpense` | 28 | 1990–2025 |
| `employees` | 31 | 1957–2013 |

(Run `python pipeline/validate.py` for the live coverage report.)

Rules:
- **Never estimate.** A value not reliably stated/legible in a filing is `null`.
- Prefer the value **as reported in that year's own report**; use later reports'
  comparison tables only to *cross-check* or to fill a gap, recording that in
  `provenance.json`.
- Pre-1923 CTR reports state *net profit*, not revenue → `revenue` is `null`,
  `netIncome` from the "NET PROFIT/INCOME — YEAR" line.
- Restatements: keep the **originally reported** figure as primary; note material
  later restatements in provenance.

## `segments.json` — revenue by reportable segment

Current four-segment structure (post-Kyndryl, Nov 2021): Software, Consulting,
Infrastructure, Financing, Other. One object per year; each year's segments sum to
that year's total revenue. **Basis note:** 2021–2023 are on the then-historical
reportable-segment basis; IBM reclassified some Software/Consulting revenue in
Q1 2025, so 2024–2025 are on the 2025 basis. Earlier segment taxonomies
(1990s–2020) differ and live in the raw report text for later extension.

## Pipeline stages (scripts in `pipeline/`)

| Stage | Script | Output |
|-------|--------|--------|
| 1. Mechanical extraction | `extract.py` | `raw/pymupdf4llm/*.md`, `raw/text/*.txt` (pymupdf), `raw/pdfplumber/*.txt` for all 116 PDFs |
| 2. Candidate harvest | `harvest.py` | `candidates.json` — every (data_year, metric, value) tuple found in any report's tables |
| 3. Reconcile | `reconcile.py` | `reconciled.json` — one value per (year, metric) from the many candidates, disagreements flagged |
| 4. Five-year tables | `build_modern.py` + `parse5yr.py` | `modern.json` — IBM's own cross-checked 1994–2018 selected-data tables |
| 5. Assemble | `assemble.py` | `financials.json` / `.csv` + `provenance.json` (anchors override reconciled override modern) |
| 6. Validate | `validate.py` | continuity + coverage + overlap report |

`anchors.json` holds manually **visually verified** figures (read from the PDF page
image) — the highest-trust tier, used for the early/mid-century era and the
recent EPS/share figures the 5-year tables no longer carry. They override the
automated layers.

## Accuracy method

- **Three parsers, cross-checked.** pymupdf4llm (best table structure on modern
  reports), pymupdf text, and pdfplumber (table/line fallback) are run on every
  file; marker-pdf (OCR) is reserved for the one scanned report (2002).
- **Self-validating overlap.** Each modern report restates 2–5 prior years and
  mid-century reports carry 5/10-year tables, so most years are stated by several
  reports. `reconcile.py` requires those to agree and flags any that don't.
- **Never estimate.** A value not reliably stated/legible stays `null`.
- **Visual verification** where the text layer is garbled (pre-~1970, the 2002
  scan, and modern per-share rows): the figure is confirmed by rendering the PDF
  page and reading it directly; `anchors.json` records source page + method.
