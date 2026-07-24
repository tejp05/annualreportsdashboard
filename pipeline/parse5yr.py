"""Parse the 'Five-Year Comparison of Selected Financial Data' table from a
modern report's extracted text (1994-2020 reports have a clean text layer and a
consistent layout: a header with 5 year tokens, then each metric label followed
by its 5 values on separate lines).

Usage: python parse5yr.py <reportYear> [--emit]
  prints the parsed metrics; --emit prints an anchors.json fragment.

This is high-trust (IBM's own cross-checked summary) and used to extend anchors
for 1995-2020 the same way the mid-century ten-year tables were read.
"""
import os
import re
import sys
import json

from manifest import ROOT

RAW = os.path.join(ROOT, "pipeline", "raw")

# label in table -> our metric key. Matched against a normalized line.
LABELMAP = [
    (r"^revenue$", "revenue"),
    (r"^net income$", "netIncome"),
    # NB: "Income from continuing operations" is a DIFFERENT line from total
    # "Net income" (the two differ by discontinued-ops result, large in 2002 and
    # 2014). Keep it separate so the canonical netIncome is always the bottom line.
    (r"^income from continuing operations$", "incomeContinuing"),
    (r"^assuming dilution$", "epsDiluted"),
    (r"^diluted$", "epsDiluted"),
    (r"^basic$", "epsBasic"),
    (r"^total assets$", "totalAssets"),
    (r"^total debt$", "totalDebt"),
    (r"^number of employees", "employees"),
    (r"^net cash provided by operating activities$", "operatingCashFlow"),
]
def numclean(s):
    """Keep only number-ish chars (handles stray $, *, NBSP/unicode-space junk)."""
    return re.sub(r"[^0-9.,()\-]", "", s)


def is_numline(s):
    c = numclean(s)
    return bool(re.fullmatch(r"\(?-?[\d,]+(?:\.\d+)?\)?", c)) and any(ch.isdigit() for ch in c)


def candidate_pages(year):
    """All (pageno, body) pages that look like the five-year selected-data table,
    across both text sources, with a 5-year run present."""
    out = []
    for sub in ("text", "pdfplumber"):
        p = os.path.join(RAW, sub, f"{year}.txt")
        if not os.path.exists(p):
            continue
        t = open(p, encoding="utf-8").read().replace("\xa0", " ")
        pages = re.split(r"===== PAGE (\d+) =====", t)
        for i in range(1, len(pages), 2):
            body = pages[i + 1]
            if re.search(r"five[\s-]*year comparison of selected financial", body, re.I) \
               and re.search(r"\brevenue\b", body, re.I) \
               and len(re.findall(r"\b(19|20)\d{2}\b", body)) >= 5:
                out.append((pages[i], body))
    return out


def num(s):
    s = numclean(s)
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace(",", "")
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def parse(year):
    for pg, body in candidate_pages(year):
        r = _parse_body(body)
        if r:
            return pg, r
    return None, None


def _parse_body(body):
    lines = [ln.strip() for ln in body.splitlines() if ln.strip()]
    # locate the 5 consecutive year header tokens
    yrs, ystart = [], None
    for idx, ln in enumerate(lines):
        if re.fullmatch(r"(19|20)\d{2}", ln):
            run = [int(lines[j]) for j in range(idx, min(idx + 5, len(lines)))
                   if re.fullmatch(r"(19|20)\d{2}", lines[j])]
            if len(run) == 5 and run[0] - run[4] == 4:
                yrs, ystart = run, idx
                break
    if not yrs:
        return None
    out = {}
    i = ystart + 5
    after_dividends = False
    pending_eps = None
    while i < len(lines):
        label = re.sub(r"\s+", " ", lines[i].lower()).strip().strip(":")
        label = label.replace("’", "'")
        # dividends-per-share is the "per share of common stock" line that follows
        # "cash dividends paid on common stock" (the EPS per-share lines come earlier)
        if re.search(r"cash dividends paid on common stock", label):
            after_dividends = True
        # 2014-2018 reports nest EPS as "Assuming dilution:" / "Basic:" headers whose
        # values live under a following "Continuing operations" sub-row.
        if re.fullmatch(r"assuming dilution", label):
            pending_eps = "epsDiluted"
        elif re.fullmatch(r"basic", label):
            pending_eps = "epsBasic"

        if after_dividends and re.fullmatch(r"per share( of common stock)?", label):
            metric = "dividendsPerShare"
            after_dividends = False
        elif pending_eps and re.fullmatch(r"continuing operations", label):
            metric = pending_eps
            pending_eps = None
        else:
            metric = next((m for pat, m in LABELMAP if re.search(pat, label)), None)
        if metric:
            vals = []
            j = i + 1
            while j < len(lines) and len(vals) < 5:
                if is_numline(lines[j]):
                    vals.append(num(lines[j]))
                    j += 1
                elif re.fullmatch(r"(19|20)\d{2}", lines[j]):
                    break
                else:
                    break
            if len(vals) == 5 and metric not in out:
                out[metric] = dict(zip(yrs, vals))
            i = j
        else:
            i += 1
    return out or None


def main():
    year = int(sys.argv[1])
    pg, out = parse(year)
    if not out:
        print(f"{year}: no table found (page={pg})")
        return
    print(f"{year} five-year table on page {pg}:")
    for m, d in out.items():
        print(f"  {m:<18}", {y: d[y] for y in sorted(d, reverse=True)})
    if "--emit" in sys.argv:
        frag = {}
        for y in sorted({yy for d in out.values() for yy in d}):
            cell = {}
            for m, d in out.items():
                if y in d and d[y] is not None:
                    cell[m] = {"value": d[y], "source": f"{year}:p{pg}", "method": "text-table"}
            frag[str(y)] = cell
        print("\n--- anchors fragment ---")
        print(json.dumps(frag, indent=1))


if __name__ == "__main__":
    main()
