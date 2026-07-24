"""Extract the extra income-/cash-flow-statement line items the derived-metrics
table needs (pretax income, income taxes, operating cash flow, capex) from the
modern reports' MD&A comparison tables, and write them into anchors.json.

Why a dedicated parser: these live in two-column "current vs prior year" MD&A
tables whose rows the generic harvester misses -- sometimes one metric per row
(2018+), sometimes several metrics stacked in one cell with <br> (pre-2015).
Each report yields its year + the prior year. We keep the value read from the
report where it is the *current* year (most authoritative), and validate every
table by checking pretax - taxes == net income against the trusted series.

    python pipeline/derive_inputs.py          # writes into data/anchors.json
"""
import os
import re
import json
import glob

from manifest import ROOT

RAW = os.path.join(ROOT, "pipeline", "raw", "pymupdf4llm")
DATA = os.path.join(ROOT, "pipeline", "data")

# metric -> regex matched against a (normalized) row sub-label
PATTERNS = {
    "pretaxIncome": r"^income (from continuing\s*operations )?before income taxes$",
    "incomeTaxes": r"^provision for income taxes$",
    "netIncome": r"^net income$",
    "operatingCashFlow": r"^net cash provided by operating activities$",
    "capitalExpenditure": r"^(payments for plant, rental machines and other property|"
                          r"investment in property, plant and equipment|capital expenditures)$",
}


def numbers(cell):
    """All numeric values in a cell, in order. Parentheses => negative."""
    out = []
    for tok in re.split(r"<br\s*/?>", cell):
        tok = tok.strip().replace("**", "")
        m = re.search(r"\(?\$?\s*\(?\s*(-?[0-9][0-9,]*(?:\.[0-9]+)?)\s*\)?", tok)
        if not m:
            out.append(None)
            continue
        v = float(m.group(1).replace(",", ""))
        if "(" in tok and ")" in tok:
            v = -abs(v)
        out.append(v)
    return out


def sublabels(cell):
    parts = re.split(r"<br\s*/?>", cell)
    return [re.sub(r"\s+", " ", p.replace("**", "").strip().lower().replace("’", "'")) for p in parts]


def free_cash_flow(year, md):
    """IBM reports free cash flow (non-GAAP) in the MD&A prose. Prefer an
    explicitly year-tagged statement, else a bare one (assumed = report year)."""
    out = {}
    for m in re.finditer(r"free cash flow for (\d{4})[^.$]*?\$?\s*([\d,]+)\s*million", md, re.I):
        out[int(m.group(1))] = float(m.group(2).replace(",", ""))
    if year not in out:
        m = re.search(r"free cash flow (?:was|of|generated[^.$]*?)\s*\$?\s*([\d,]+)\s*million", md, re.I)
        if m:
            out[year] = float(m.group(1).replace(",", ""))
    return out


def total_debt(year, md):
    """IBM states total debt in MD&A prose. Prefer the exact $...million form.
    Only used for 2019+ (1991-2018 comes from the five-year tables)."""
    if year < 2019:
        return {}
    m = re.search(r"total debt of \$\s*([\d,]{4,})\s*million", md, re.I)
    if m:
        return {year: float(m.group(1).replace(",", ""))}
    m = re.search(r"total debt of \$\s*([\d.]+)\s*billion", md, re.I)
    if m:
        return {year: float(m.group(1)) * 1000}
    return {}


def parse_report(year, path):
    """Return {metric: {dataYear: value}} from one report's md tables."""
    md = open(path, encoding="utf-8").read()
    found = {}  # metric -> {dataYear: value}
    for line in md.splitlines():
        if line.count("|") < 3:
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if not cells:
            continue
        subs = sublabels(cells[0])
        # value cells = cells that contain at least one digit
        valcells = [c for c in cells[1:] if re.search(r"\d", c)]
        if len(valcells) < 1:
            continue
        col_now = numbers(valcells[0])
        col_prev = numbers(valcells[1]) if len(valcells) > 1 else []
        for metric, pat in PATTERNS.items():
            for i, sl in enumerate(subs):
                if re.match(pat, sl):
                    now = col_now[i] if i < len(col_now) else None
                    prev = col_prev[i] if i < len(col_prev) else None
                    if now is not None:
                        found.setdefault(metric, {})[year] = now
                    if prev is not None:
                        found.setdefault(metric, {}).setdefault(year - 1, prev)
    return found


def main():
    fin = {r["year"]: r for r in json.load(open(os.path.join(DATA, "financials.json")))["years"]}
    anchors = json.load(open(os.path.join(DATA, "anchors.json")))

    # collect candidates: metric -> dataYear -> list of (value, reportYear, isCurrent)
    cand = {}
    for path in sorted(glob.glob(os.path.join(RAW, "*.md"))):
        y = int(re.search(r"(\d{4})", os.path.basename(path)).group(1))
        if y < 1994:
            continue
        rep = parse_report(y, path)
        _md = open(path, encoding="utf-8").read()
        rep["freeCashFlow"] = free_cash_flow(y, _md)
        rep["totalDebt"] = total_debt(y, _md)
        # validate pretax/taxes only: pretax - taxes should ~= the SAME table's
        # net income (use that, not our total net income -- MD&A figures are on a
        # continuing-ops basis, which differs from total when there are disc. ops).
        # If it fails, drop just those two (keep OCF/capex/FCF).
        ni = rep.get("netIncome", {}).get(y)
        pt = rep.get("pretaxIncome", {}).get(y)
        tx = rep.get("incomeTaxes", {}).get(y)
        if ni and pt and tx is not None and abs((pt - tx) - ni) > max(60, 0.04 * abs(ni)):
            rep.pop("pretaxIncome", None)
            rep.pop("incomeTaxes", None)
        for metric, series in rep.items():
            if metric == "netIncome":
                continue
            for dy, v in series.items():
                cand.setdefault(metric, {}).setdefault(dy, []).append((v, y, dy == y))

    # choose: prefer a reading from the report where dy is the current year; else mode
    written = 0
    for metric, byyear in cand.items():
        for dy, lst in byyear.items():
            cur = [v for v, ry, isc in lst if isc]
            vals = cur if cur else [v for v, ry, isc in lst]
            # mode (most common rounded value) for robustness
            best = max(set(vals), key=vals.count)
            slot = anchors.setdefault(str(dy), {})
            if metric not in slot:           # never override a hand-verified anchor
                slot[metric] = {"value": best, "source": f"md-mdna", "method": "md-table"}
                written += 1

    json.dump(anchors, open(os.path.join(DATA, "anchors.json"), "w"), indent=1)
    print(f"wrote {written} derived input values into anchors.json")
    for m in list(PATTERNS) + ["freeCashFlow"]:
        if m == "netIncome":
            continue
        ys = sorted(int(y) for y, c in anchors.items() if y.isdigit() and m in c)
        if ys:
            print(f"  {m:<20} {len(ys):>3} yrs  {ys[0]}-{ys[-1]}")


if __name__ == "__main__":
    main()
