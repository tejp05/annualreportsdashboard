"""Text-line harvester for reports whose markdown has no usable tables
(mostly pre-1990). Scans the pdfplumber + pymupdf plain text for labeled
financial lines and records the number(s) found on / just after the label line,
with the page number. These are *candidates* only -- reconcile.py + visual
verification decide the canonical value. Lower trust than md-table candidates,
so each is tagged where="text" and value goes in only if md gave nothing.

Writes pipeline/data/candidates_text.json (same shape as candidates.json).
"""
import os
import re
import json

from manifest import ROOT, primary_entries

RAW = os.path.join(ROOT, "pipeline", "raw")
OUT = os.path.join(ROOT, "pipeline", "data", "candidates_text.json")

LABELS = {
    "revenue": [
        r"gross income from sales", r"total gross income", r"\bgross income\b",
        r"total revenue", r"\brevenues?\b", r"net sales", r"total sales",
    ],
    "netIncome": [
        r"net income applicable to", r"net income attributable",
        r"net income before", r"\bnet income\b", r"net earnings",
        r"net profit for the year", r"\bnet profit\b",
    ],
    "totalAssets": [r"total assets"],
    "stockholdersEquity": [r"stockholders.? equity", r"shareholders.? equity"],
    "employees": [
        r"number of employees", r"employees at year-?end",
        r"regular employees", r"\bemployees\b",
    ],
    "dividendsPerShare": [r"dividends? per .*share", r"per share .*dividend"],
}
PAGE_RE = re.compile(r"=====\s*PAGE\s+(\d+)\s*=====")
NUM_RE = re.compile(r"\(?\$?\s*([0-9][0-9,]{2,}(?:\.[0-9]+)?)\)?")
PERSHARE_RE = re.compile(r"\$?\s*([0-9]{1,3}(?:\.[0-9]{1,2})?)")


def numbers_on(line, per_share=False):
    rx = PERSHARE_RE if per_share else NUM_RE
    out = []
    for m in rx.finditer(line):
        s = m.group(1)
        neg = "(" in line[:m.start()][-1:] if m.start() else False
        try:
            v = float(s.replace(",", ""))
        except ValueError:
            continue
        out.append(v)
    return out


def harvest(report_year, text, sink):
    page = 0
    lines = text.splitlines()
    for i, raw in enumerate(lines):
        pm = PAGE_RE.search(raw)
        if pm:
            page = int(pm.group(1))
            continue
        low = raw.lower()
        for metric, pats in LABELS.items():
            if any(re.search(p, low) for p in pats):
                per_share = metric in ("dividendsPerShare",)
                nums = numbers_on(raw, per_share)
                if not nums and i + 1 < len(lines):
                    nums = numbers_on(lines[i + 1], per_share)
                for v in nums[:3]:
                    sink.setdefault(metric, {}).setdefault(str(report_year), []).append({
                        "value": v, "report": report_year, "where": "text",
                        "page": page, "raw": raw.strip()[:120],
                    })
                break


def main():
    cand = {}
    for e in primary_entries():
        y = e["year"]
        for sub in ("pdfplumber", "text"):
            p = os.path.join(RAW, sub, f"{y}.txt")
            if os.path.exists(p):
                with open(p, encoding="utf-8") as f:
                    harvest(y, f.read(), cand)
                break
    json.dump(cand, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    for m in LABELS:
        print(f"{m:<20} years={len(cand.get(m,{}))}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
