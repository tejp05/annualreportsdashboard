"""Collapse the many (year, metric) candidates into one canonical value + flags.

Voting model: each distinct *reporting report* gets one vote for a value (so the
same number printed five times in one report doesn't outvote four other reports).
The value with the most report-votes wins. Ties break toward the value reported
**in the year's own report** (most authoritative for original figures), then the
most recent report. Disagreements beyond tolerance are recorded in `flags`.

Metric-specific sanity filters reject known traps:
  * EPS/dividends-per-share: must be a small per-share number, not a share count.
  * totalAssets / equity: collapse each report's duplicate rows by max (the
    consolidated figure dwarfs financing-segment sub-tables).
"""
import os
import json
from collections import defaultdict

from manifest import ROOT

DATA = os.path.join(ROOT, "pipeline", "data")
CAND = os.path.join(DATA, "candidates.json")
OUT = os.path.join(DATA, "reconciled.json")

# (lo, hi) plausible absolute-value range per metric. None = no bound.
RANGE = {
    "revenue": (0.0, 400000),            # US$ millions
    "netIncome": (-20000, 40000),
    "totalAssets": (0.0, 400000),
    "stockholdersEquity": (-10000, 200000),
    "rdExpense": (0.0, 30000),
    "epsDiluted": (-20, 60),             # per share
    "epsBasic": (-20, 60),
    "dividendsPerShare": (0.0, 60),
    "employees": (100, 600000),
}
# metrics whose per-report duplicates should collapse to the max (segment traps)
MAX_COLLAPSE = {"totalAssets", "stockholdersEquity"}
# rounding tolerance for "same value" per metric
def same(metric, a, b):
    if metric in ("epsDiluted", "epsBasic", "dividendsPerShare"):
        return abs(a - b) <= 0.02
    # money / employees: allow 0.5% or 1 unit rounding
    return abs(a - b) <= max(1.0, 0.005 * max(abs(a), abs(b)))


# Minimum absolute magnitude to reject scale noise (billions read as units,
# garbled OCR cells). Safe because anchors cover <=1994; surviving auto values
# are the modern era where these metrics are tens of thousands of $M.
MINABS = {"revenue": 1000, "netIncome": 100, "totalAssets": 1000,
          "stockholdersEquity": 1000, "rdExpense": 100}


def in_range(metric, v):
    lo, hi = RANGE[metric]
    if metric in MINABS and abs(v) < MINABS[metric]:
        return False
    return (lo is None or v >= lo) and (hi is None or v <= hi)


def reconcile_metric(metric, by_year):
    out = {}
    for year, cands in by_year.items():
        cands = [c for c in cands if in_range(metric, c["value"])]
        if not cands:
            continue
        # one value per report
        per_report = {}
        for c in cands:
            r = c["report"]
            if r not in per_report:
                per_report[r] = c["value"]
            elif metric in MAX_COLLAPSE:
                per_report[r] = max(per_report[r], c["value"], key=abs)
            # else keep first seen for that report
        # cluster report-votes by value
        clusters = []  # list of [repr_value, votes, set(reports)]
        for rpt, val in per_report.items():
            placed = False
            for cl in clusters:
                if same(metric, cl[0], val):
                    cl[1] += 1
                    cl[2].add(rpt)
                    placed = True
                    break
            if not placed:
                clusters.append([val, 1, {rpt}])
        # choose winner: most votes, tie -> own-year report value, then newest
        iyear = int(year)

        def score(cl):
            own = 1 if any(r == iyear for r in cl[2]) else 0
            newest = max(cl[2])
            return (cl[1], own, newest)

        clusters.sort(key=score, reverse=True)
        winner = clusters[0]
        flags = []
        if len(clusters) > 1:
            others = [round(c[0], 3) for c in clusters[1:]]
            flags.append(f"disagree:{round(winner[0],3)}vs{others}")
        out[year] = {
            "value": winner[0],
            "votes": winner[1],
            "reports": sorted(winner[2]),
            "flags": flags,
        }
    return out


def main():
    cand = json.load(open(CAND, encoding="utf-8"))
    reconciled = {m: reconcile_metric(m, cand.get(m, {})) for m in RANGE}

    # assemble per-year records
    years = set()
    for m in reconciled:
        years.update(int(y) for y in reconciled[m])
    records = []
    for y in sorted(years):
        rec = {"year": y, "currency": "USD_millions"}
        any_flag = []
        for m in RANGE:
            cell = reconciled[m].get(str(y))
            rec[m] = round(cell["value"], 3) if cell else None
            if cell and cell["flags"]:
                any_flag.append(f"{m}:{cell['flags'][0]}")
        rec["flags"] = any_flag
        records.append(rec)

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"currency": "USD_millions",
                   "note": "Canonical IBM/CTR series reconciled across all reports. null=not extracted/uncertain.",
                   "years": records}, f, ensure_ascii=False, indent=1)

    filled = sum(1 for r in records if r["revenue"] is not None or r["netIncome"] is not None)
    flagged = sum(1 for r in records if r["flags"])
    print(f"{len(records)} year-records | {filled} with rev/netIncome | {flagged} flagged")
    print(f"year span: {records[0]['year']}..{records[-1]['year']}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
