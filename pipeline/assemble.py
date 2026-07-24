"""Assemble the final canonical dataset.

  reconciled.json  (automated md-table voting, strong for ~1990-2025)
+ anchors.json     (manually VERIFIED early/mid-century figures -- override)
= financials.json  (one record per fiscal year 1911-2025)
+ financials.csv   (flat)
+ provenance.json  (where every non-null number came from)

Anchors always win over automated values (they are human-verified). Every cell's
origin is recorded in provenance.json so the dashboard can show sources.
"""
import os
import csv
import json

from manifest import ROOT

DATA = os.path.join(ROOT, "pipeline", "data")
METRICS = ["revenue", "netIncome", "grossProfit", "rdExpense", "operatingIncome",
           "pretaxIncome", "incomeTaxes", "operatingCashFlow", "freeCashFlow", "totalAssets",
           "totalLiabilities", "stockholdersEquity",
           "longTermDebt", "totalDebt", "cashAndEquivalents", "capitalExpenditure",
           "epsBasic", "epsDiluted", "dividendsPerShare", "sharesOutstandingM",
           "employees", "softwareARR"]
CORE_CSV = ["year", "revenue", "netIncome", "grossProfit", "rdExpense",
            "totalAssets", "stockholdersEquity", "epsDiluted", "dividendsPerShare",
            "employees", "basis", "flags"]


def load(name, default):
    p = os.path.join(DATA, name)
    return json.load(open(p, encoding="utf-8")) if os.path.exists(p) else default


def main():
    reconciled = load("reconciled.json", {"years": []})
    anchors = load("anchors.json", {})
    modern = load("modern.json", {})   # 5-year-table tier (1995-2020)
    rec_by_year = {r["year"]: r for r in reconciled.get("years", [])}

    years = set(rec_by_year) | {int(y) for y in anchors if y.isdigit()}
    if years:
        full = range(min(years), max(years) + 1)
    else:
        full = []

    records, prov = [], {}
    for y in full:
        rec = {"year": y, "currency": "USD_millions"}
        base = rec_by_year.get(y, {})
        pcell = {}
        bases = []
        flags = list(base.get("flags", []))
        for m in METRICS:
            val = base.get(m)
            src = "md-vote" if val is not None else None
            # modern five-year-table tier (overrides md-vote)
            mo = modern.get(str(y), {}).get(m)
            if mo is not None:
                val = mo["value"]
                src = mo.get("source", "5yr-table")
                if mo.get("flags"):
                    flags.append(f"{m}:5yr_{mo['flags'][0]}")
            # anchor override (highest priority)
            a = anchors.get(str(y), {}).get(m)
            if a is not None:
                if val is not None and abs((val or 0) - a["value"]) > max(1.0, 0.02 * abs(a["value"])):
                    flags.append(f"{m}:anchor_overrode_md({val}->{a['value']})")
                val = a["value"]
                src = a.get("source", "anchor")
                if a.get("basis"):
                    bases.append(f"{m}={a['basis']}")
            rec[m] = val
            if val is not None and src:
                pcell[m] = src
        rec["basis"] = "; ".join(bases) if bases else None
        rec["flags"] = flags
        records.append(rec)
        if pcell:
            prov[str(y)] = pcell

    out = {"dataset": "IBM/CTR annual-report financials",
           "currency": "USD_millions",
           "fiscalYears": f"{records[0]['year']}-{records[-1]['year']}" if records else "",
           "note": "Anchors are human-verified from the PDFs; md-vote values reconciled across reports. null = not yet extracted/uncertain (never estimated). 'basis' notes domestic-vs-worldwide and pre/post-tax where relevant.",
           "years": records}
    json.dump(out, open(os.path.join(DATA, "financials.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    json.dump(prov, open(os.path.join(DATA, "provenance.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)

    with open(os.path.join(DATA, "financials.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(CORE_CSV)
        for r in records:
            w.writerow([r["year"]] + [r.get(c) for c in CORE_CSV[1:-2]] +
                       [r.get("basis"), "|".join(r.get("flags", []))])

    nrev = sum(1 for r in records if r["revenue"] is not None)
    nni = sum(1 for r in records if r["netIncome"] is not None)
    print(f"{len(records)} years {records[0]['year']}-{records[-1]['year']} | "
          f"revenue:{nrev} netIncome:{nni}")
    print("wrote financials.json, financials.csv, provenance.json")


if __name__ == "__main__":
    main()
