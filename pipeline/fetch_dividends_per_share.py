"""
fetch_dividends_per_share.py
============================
Fills the tail of financials[].dividendsPerShare, which stopped at 2017 while
every other series on the Macro tab's hero chart ran to 2025. The Dividends
layer therefore drew 38 bars and then went blank for the last nine years of the
chart.

Source: SEC EDGAR XBRL, us-gaap:CommonStockDividendsPerShareCashPaid, annual
10-K periods only. This is IBM's own filed figure, which is what the existing
1980-2017 values are, so the two splice without a basis change -- the tag
reproduces the stored 2016 (5.50) and 2017 (5.90) exactly, and the script
asserts that before writing anything.

Do NOT source this from Yahoo's dividend events instead. Those are adjusted for
the Nov 2021 Kyndryl spin-off and come out ~4.4% low against the filed figure
in every overlapping year (2017: 5.64 vs 5.90), so splicing them onto the
filings series would put a visible step in the middle of the chart.

Run: python pipeline/fetch_dividends_per_share.py   (needs internet access)
"""
import json
import datetime
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent.parent
FIN = ROOT / "pipeline" / "data" / "financials.json"
HEADERS = {"User-Agent": "annualreportsdashboard tejpatel@umich.edu"}
TAG = "CommonStockDividendsPerShareCashPaid"


def annual_from_xbrl():
    url = "https://data.sec.gov/api/xbrl/companyfacts/CIK0000051143.json"
    facts = json.loads(urllib.request.urlopen(
        urllib.request.Request(url, headers=HEADERS), timeout=60).read())["facts"]["us-gaap"]
    out = {}
    for row in facts[TAG]["units"]["USD/shares"]:
        if row.get("form") != "10-K" or not row.get("start") or not row.get("end"):
            continue
        start = datetime.date(*map(int, row["start"].split("-")))
        end = datetime.date(*map(int, row["end"].split("-")))
        if end.month == 12 and 350 <= (end - start).days <= 370:
            out[end.year] = row["val"]
    return out


def main():
    filed = annual_from_xbrl()
    data = json.loads(FIN.read_text(encoding="utf-8"))
    rows = {e["year"]: e for e in data["years"]}

    # The splice is only safe if the tag agrees with what the filings-parsed
    # series already holds. Bail rather than introduce a step in the chart.
    overlap = [y for y in filed if rows.get(y, {}).get("dividendsPerShare") is not None]
    drift = {y: (rows[y]["dividendsPerShare"], filed[y])
             for y in overlap if abs(rows[y]["dividendsPerShare"] - filed[y]) > 0.005}
    if drift:
        raise SystemExit(f"ABORT: XBRL disagrees with stored filings values: {drift}")
    print(f"overlap validated on {sorted(overlap)} - identical")

    added = {}
    for year, val in sorted(filed.items()):
        row = rows.get(year)
        if row is None:
            continue
        if row.get("dividendsPerShare") is None:
            row["dividendsPerShare"] = val
            added[year] = val
    FIN.write_text(json.dumps(data, indent=1) + "\n", encoding="utf-8")
    print(f"filled {len(added)} year(s): {added}")


if __name__ == "__main__":
    main()
