# IBM/CTR annual-report data pipeline (1911–2025)

Turns the 116 annual-report PDFs in `../Intern Project- Annual Reports/` into a
standardized, **auditable** financial dataset for the dashboard. Every published
number is traceable to a specific report and page, and nothing is estimated —
values that can't be read reliably from a filing stay `null`.

## Why it's built this way

Auto-scraping 114 years of filings is unreliable: pre-1970 reports have a
garbled OCR text layer with labels and numbers spatially separated; "Total
assets" appears in both the consolidated balance sheet and financing-segment
sub-tables; modern 10-Ks (2021+) dropped the Selected Financial Data table; and
IBM restated prior years for divestitures and changed basis (US-domestic →
worldwide) around 1960. So the pipeline separates **mechanical extraction** from
**adjudication**, keeps the raw evidence in the repo, and layers sources by trust.

## Tools

Parsing uses the libraries that run on this machine's Python 3.14:
- **pymupdf4llm** → structured Markdown (best on modern reports' tables/narrative)
- **pdfplumber** → tables + text (best on financial tables)
- **PyMuPDF (fitz)** → plain page text + **page rendering** for visual verification

> `marker-pdf` was requested but can't run here: it requires PyTorch, which has
> no Python-3.14 wheels and won't build without an MSVC toolchain. Per direction,
> its role — OCR of the one scanned report (2002) and high-fidelity table reads —
> is done instead by rendering pages to PNG and reading them directly (`render.py`).

## Stages

| Step | Script | Output |
|------|--------|--------|
| 0. Probe | `probe.py` | `data/probe.tsv` — pages, text density, scanned-vs-text per file |
| 1. Map files → fiscal year | `manifest.py` | resolves 1911/1912 split, 1984 duplicate |
| 2. Mechanical extract (all 116) | `extract.py` | `raw/pymupdf4llm/*.md`, `raw/text/*.txt`, `raw/pdfplumber/*.{txt,tables.json}` |
| 3a. Harvest md tables | `harvest.py` | `data/candidates.json` (every year→value seen in a markdown table) |
| 3b. Harvest text lines | `harvest_text.py` | `data/candidates_text.json` (older reports) |
| 4. Reconcile md votes | `reconcile.py` | `data/reconciled.json` (cross-report voting + sanity filters) |
| 5. Modern 5-yr tables | `parse5yr.py` + `build_modern.py` | `data/modern.json` (1995–2020, cross-validated, as-originally-reported) |
| 6. Manual anchors | `data/anchors.json` | human-verified early/mid-century + loss years (visual + arithmetic) |
| 7. Assemble | `assemble.py` | **`data/financials.json`**, `financials.csv`, `provenance.json` |
| 8. Validate | `validate.py` | `data/validation.json` — continuity, coverage, gaps |

Render any page for review: `python render.py <year> <page-or-range> [dpi]`.

## Source trust order (highest wins in `assemble.py`)

1. **`anchors.json`** — manually verified by reading the PDF page (and cross-checked
   by arithmetic: pre-tax − tax = net). Covers the hard parts: 1911–1949 (CTR/early
   IBM, WWII excess-profits-tax years), 1950–1989 ten-year/five-year tables,
   1990–1994 loss years.
2. **`modern.json`** — IBM's own five-year Selected Financial Data tables, parsed
   from text and cross-validated across overlapping reports (1995–2020). Uses the
   value **as originally reported** (earliest report); later restatements are flagged.
3. **`reconciled.json`** — automated markdown-table voting (fallback / recent years).

## Conventions

- **Money in US$ millions**, as reported. `null` = not reliably stated/legible.
- Keyed by **fiscal year**. `basis` field flags domestic-vs-worldwide and
  pre/post-tax where it matters; `flags` records restatements and disagreements.
- Provenance for every number is in `provenance.json` (`<report>:p<page>`).

## Re-run

```bash
python pipeline/extract.py            # PDFs -> raw/ (slow; ~90 min, once)
python pipeline/harvest.py && python pipeline/harvest_text.py
python pipeline/reconcile.py
python pipeline/build_modern.py
python pipeline/assemble.py
python pipeline/validate.py
```

## Known basis notes

- **1911–1913** CTR formation years; figures are constituent-company / partial.
- **1915–1928** "net profit/income for year"; low-tax era (figure ≈ pre-tax).
- **1940–1945** after-tax net income was held flat (~$8–11M) by WWII excess-profits
  taxes — the headline "net profit" lines are *pre-tax* and are deliberately not used.
- **1950–1959** US-domestic gross income (World Trade reported separately then).
- **1960+** worldwide consolidated (World Trade consolidated) — a basis step-up at 1960.
- **2021+** 10-Ks dropped Selected Financial Data; those years come from the
  consolidated statements (current + prior-year columns).
```
