"""Run the five-year-table parser across every 1994-2020 report and cross-validate.

Each report's 'Five-Year Comparison of Selected Financial Data' overlaps its
neighbours by four years, so collecting all of them gives 4-5 independent reads
of most years. We take the agreed value and flag any year/metric where reports
disagree. Output: pipeline/data/modern.json (a high-trust tier between the manual
anchors and the md-vote reconciliation).
"""
import os
import json
from collections import defaultdict

from manifest import ROOT, primary_entries
from parse5yr import parse

OUT = os.path.join(ROOT, "pipeline", "data", "modern.json")


def same(metric, a, b):
    if metric in ("epsDiluted", "epsBasic"):
        return abs(a - b) <= 0.02
    return abs(a - b) <= max(1.0, 0.005 * max(abs(a), abs(b)))


def main():
    collected = defaultdict(lambda: defaultdict(list))  # metric -> year -> [(v,report,page)]
    used = []
    for e in primary_entries():
        ry = e["year"]
        if not (1994 <= ry <= 2020):
            continue
        pg, out = parse(ry)
        if not out:
            continue
        used.append(ry)
        for metric, d in out.items():
            for dy, v in d.items():
                if v is not None:
                    collected[metric][dy].append((v, ry, pg))

    result = {}  # year -> metric -> {value, sources, flags}
    for metric, byyear in collected.items():
        for dy, lst in byyear.items():
            # cluster by value
            clusters = []
            for v, ry, pg in lst:
                for cl in clusters:
                    if same(metric, cl["v"], v):
                        cl["reports"].append(ry)
                        break
                else:
                    clusters.append({"v": v, "reports": [ry], "page": pg})
            # Prefer the value as ORIGINALLY reported: the cluster containing the
            # earliest report that covered this data year (later reports may
            # restate for divestitures/discontinued ops). Tie-break by agreement.
            for cl in clusters:
                cl["minreport"] = min(cl["reports"])
            clusters.sort(key=lambda c: (c["minreport"], -len(c["reports"])))
            win = clusters[0]
            cell = {"value": win["v"],
                    "source": f"{min(win['reports'])}:p{win['page']}",
                    "agree": len(win["reports"]),
                    "reports": sorted(win["reports"])}
            if len(clusters) > 1:
                others = [{"value": round(c["v"], 3), "firstReport": c["minreport"]}
                          for c in clusters[1:]]
                cell["flags"] = [f"restated_or_disagree:orig={win['v']}({win['minreport']});later={others}"]
            result.setdefault(str(dy), {})[metric] = cell

    json.dump(result, open(OUT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    yrs = sorted(int(y) for y in result)
    print(f"parsed five-year tables from reports: {used}")
    print(f"modern.json covers data-years {min(yrs)}-{max(yrs)} ({len(yrs)} years)")
    disagreements = [(y, m) for y in result for m, c in result[y].items() if c.get("flags")]
    print(f"disagreements flagged: {len(disagreements)} -> {disagreements[:12]}")


if __name__ == "__main__":
    main()
