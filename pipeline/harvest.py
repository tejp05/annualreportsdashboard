"""Harvest (data_year -> value) candidates for each core metric from every report.

Strategy that makes the series self-validating: every annual report states not
just the current year but one or more prior years (income statement prior-year
column, balance-sheet prior year, and -- in 1994-2020 reports -- a five-year
"Selected Financial Data" table; in mid-century reports a 5/10-year table). So
we collect *every* (reporting_report, data_year, metric, value) tuple we can,
keyed by data_year. reconcile.py then turns the many candidates per (year,metric)
into one canonical value and flags disagreements.

This module reads the pymupdf4llm markdown (best table structure on modern
reports) and the pdfplumber/pymupdf text (fallback for older reports).

Output: pipeline/data/candidates.json
  { "<metric>": { "<data_year>": [ {value, report, where, raw} , ... ] } }
"""
import os
import re
import json
import glob

from manifest import ROOT, primary_entries

RAW = os.path.join(ROOT, "pipeline", "raw")
OUT = os.path.join(ROOT, "pipeline", "data", "candidates.json")

# Metric -> list of label regexes (lowercased match against a row's label cell).
# Order matters: more specific first. We deliberately EXCLUDE segment/sub-tables
# by requiring the canonical phrasing used in IBM's consolidated statements.
METRICS = {
    "revenue": [
        r"^total revenue$", r"^total revenue[s]?\b", r"^revenue[s]?$",
        r"^total gross income", r"^gross income from", r"^gross income$",
        r"^total income$", r"^net sales and",
    ],
    "netIncome": [
        r"^net income$", r"^net income attributable to",
        r"^net income applicable to", r"^net earnings$",
        r"^net income/?\(loss\)$", r"^net profit for", r"^net income for",
        r"^net earnings/?\(loss\)$",
    ],
    "totalAssets": [r"^total assets$"],
    "stockholdersEquity": [
        r"^total (ibm )?stockholders.? equity$", r"^total equity$",
        r"^stockholders.? equity$", r"^total shareholders.? equity$",
    ],
    "rdExpense": [
        r"^total research, development and engineering$",
        r"^research, development and engineering$",
        r"^research, development and engineering expense$",
    ],
    "epsDiluted": [
        r"assuming dilution$", r"^diluted$",
        r"^diluted earnings per share.*continuing", r"^diluted$",
        r"net income.*per share.*diluted", r"^earnings per share.*diluted",
    ],
    "epsBasic": [
        r"^basic$", r"^basic earnings per share",
    ],
    "dividendsPerShare": [
        r"^dividends per (common )?share", r"^cash dividends (declared )?per",
        r"^per share of common stock.*dividend",
    ],
    "employees": [
        r"^number of employees", r"^employees$", r"^total employees",
        r"^number of regular employees",
    ],
    # --- inputs for the derived-metrics table (FCF / margin / ROIC) -----------
    "operatingCashFlow": [
        r"^net cash provided by operating activities$",
        r"^net cash from operating activities$",
        r"^cash provided by operating activities$",
        r"^net cash provided by/?\(used in\) operating activities$",
    ],
    "capitalExpenditure": [
        r"^payments for plant, rental machines and other property$",
        r"^investment in property, plant and equipment$",
        r"^capital expenditures$", r"^net capital expenditures$",
    ],
    "pretaxIncome": [
        r"^income from continuing operations before income taxes$",
        r"^income before income taxes$", r"^income before taxes$",
        r"^income/?\(loss\) from continuing operations before income taxes$",
    ],
    "cashAndEquivalents": [
        r"^cash and cash equivalents$",
    ],
    "incomeTaxes": [
        r"^provision for income taxes$", r"^income tax provision$",
        r"^income tax expense$", r"^benefit for/?\(provision for\) income taxes$",
    ],
}

MONEY = re.compile(r"\(?\$?\s*-?\(?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*\)?")
YEAR = re.compile(r"\b(18|19|20)\d{2}\b")


def parse_money(cell):
    """Return float from a table cell, or None. Parentheses => negative."""
    if cell is None:
        return None
    s = cell.strip()
    if s in {"", "$", "—", "-", "–", "n/a", "na", "*"}:
        return None
    neg = "(" in s and ")" in s
    m = re.search(r"([0-9][0-9,]*(?:\.[0-9]+)?)", s)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    return -v if neg else v


def md_tables(md_text):
    """Yield (header_cells, [row_cells,...]) for each pipe-table in markdown."""
    lines = md_text.splitlines()
    i = 0
    while i < len(lines):
        if lines[i].strip().startswith("|") and lines[i].count("|") >= 2:
            block = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                block.append(lines[i])
                i += 1
            # drop separator rows like |---|---|
            rows = []
            for b in block:
                cells = [c.strip() for c in b.strip().strip("|").split("|")]
                if all(re.fullmatch(r":?-{2,}:?", c or "-") for c in cells):
                    continue
                rows.append(cells)
            if rows:
                yield rows[0], rows[1:]
        else:
            i += 1


def header_year_cols(header, body):
    """Map column index -> data_year using the header row; if the header has no
    years, fall back to scanning the first few rows for a year row."""
    candidates = [header] + body[:3]
    best = {}
    for row in candidates:
        cols = {}
        for idx, cell in enumerate(row):
            ys = YEAR.findall(cell or "")
            # findall returns the group ('19'/'20'); re-find full years
            for ym in re.finditer(r"\b((?:18|19|20)\d{2})\b", cell or ""):
                cols[idx] = int(ym.group(1))
                break
        if len(cols) > len(best):
            best = cols
    return best  # {col_index: year}


def match_metric(label):
    lab = re.sub(r"\s+", " ", label.lower()).strip().strip("*").strip()
    lab = lab.replace("’", "'")
    for metric, pats in METRICS.items():
        for p in pats:
            if re.search(p, lab):
                return metric
    return None


def harvest_md(report_year, md_text, sink):
    for header, body in md_tables(md_text):
        ycols = header_year_cols(header, body)
        if not ycols:
            continue
        # the label is usually column 0
        for row in body:
            if not row:
                continue
            label = row[0]
            metric = match_metric(label)
            if not metric:
                continue
            for cidx, yr in ycols.items():
                if cidx < len(row):
                    val = parse_money(row[cidx])
                    if val is not None and 1900 <= yr <= 2025:
                        sink.setdefault(metric, {}).setdefault(str(yr), []).append({
                            "value": val, "report": report_year,
                            "where": "md-table", "raw": " | ".join(row)[:160],
                        })


def main():
    cand = {}
    md_dir = os.path.join(RAW, "pymupdf4llm")
    for e in primary_entries():
        y = e["year"]
        md_path = os.path.join(md_dir, f"{y}.md")
        if not os.path.exists(md_path):
            continue
        with open(md_path, encoding="utf-8") as f:
            harvest_md(y, f.read(), cand)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cand, f, ensure_ascii=False, indent=1)
    # summary
    for metric in METRICS:
        yrs = cand.get(metric, {})
        ncand = sum(len(v) for v in yrs.values())
        print(f"{metric:<20} years={len(yrs):>3}  candidates={ncand}")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
