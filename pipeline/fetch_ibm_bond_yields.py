"""
fetch_ibm_bond_yields.py
========================
Build IBM's effective cost of debt alongside the U.S. Treasury curve, for the
"IBM's Cost of Debt vs the Risk-Free Curve" card on the Macro vs IBM tab.

WHAT "IBM's cost of debt" MEANS HERE -- read before using these numbers.
IBM has no single quoted "corporate bond yield". It has ~40 outstanding bond
issues at different coupons, tenors and currencies, and the market yield on
each moves daily. There is no free, reachable historical series of IBM's
traded bond yields (FRED, which carries the rating-bucket corporate indices,
is not reachable from this network -- same limitation already recorded for
fedFundsRate in macro.sources).

So this series measures what IBM actually paid, from IBM's own filings:

    effective cost of debt (year Y) = interest costs incurred in Y
                                      -------------------------------------
                                      average(total debt Y-1, total debt Y)

That is a BOOK / REALISED rate across the whole debt stack, not the marginal
market yield on a new IBM issue. The distinction matters and is stated on the
chart itself: when rates move, this series lags, because it only reprices as
old bonds mature and are refinanced. That lag is the single most interesting
thing in the data (see below), so it must not be presented as a market yield.

Tag choice: us-gaap:InterestCostsIncurred, NOT us-gaap:InterestExpense.
IBM charges its Global Financing segment's borrowing cost to cost of financing
rather than to the interest expense line, so InterestExpense understates the
cost of the total debt balance it would be divided by -- it produces an absurd
1.1-1.5% for 2013-2018. InterestCostsIncurred is IBM's total interest cost.
Cross-checked against InterestPaidNet (cash interest actually paid) in the
same filings: the two agree within ~0.2pp in every overlapping year, which is
what validates the method.

WHAT THE DATA SHOWS: IBM's cost of debt ran ~2pp ABOVE the 10-year Treasury
through ZIRP (2020: 2.80% vs 0.82%), and now sits BELOW it (2025: 3.97% vs
4.24%) -- IBM's stack is still full of cheap bonds issued in the ZIRP years
that have not rolled over yet, while Treasuries have fully repriced.

Sources:
  IBM interest + debt : SEC EDGAR XBRL companyfacts, CIK 0000051143
                        (us-gaap:InterestCostsIncurred, us-gaap:InterestPaidNet)
                        Total debt from pipeline/data/financials.json, which is
                        hand-verified off the 10-K balance sheets.
  Treasury curve      : Yahoo Finance ^IRX (13-week bill), ^FVX (5-yr note),
                        ^TNX (10-yr note), ^TYX (30-yr bond). Annual mean of
                        monthly closes -- an average, to match IBM's cost of
                        debt, which is itself a full-year average. Do not
                        compare these against macro.treasury10yr, which is a
                        Jan-1 point reading from multpl.com.

Output: pipeline/data/ibm_bond_yields.json

Run: python pipeline/fetch_ibm_bond_yields.py   (needs internet access)
"""
import os
import json
import datetime
import collections
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "pipeline", "data")
FINANCIALS_IN = os.path.join(DATA_DIR, "financials.json")
OUT = os.path.join(DATA_DIR, "ibm_bond_yields.json")

CIK = "0000051143"
# SEC requires a descriptive UA with a contact address on automated requests.
SEC_HEADERS = {"User-Agent": "annualreportsdashboard tejpatel@umich.edu"}
YAHOO_HEADERS = {"User-Agent": "Mozilla/5.0"}

TENORS = [
    ("%5EIRX", "3m",  "13-week Treasury bill"),
    ("%5EFVX", "5y",  "5-year Treasury note"),
    ("%5ETNX", "10y", "10-year Treasury note"),
    ("%5ETYX", "30y", "30-year Treasury bond"),
]


def annual_from_xbrl(facts, tag):
    """Pull full-year 10-K values for a us-gaap tag, keyed by fiscal year.

    IBM's fiscal year ends Dec 31, so we keep only periods that end in December
    and span ~a year -- this drops the quarterly and cumulative-stub contexts
    that also carry the same tag.
    """
    out = {}
    if tag not in facts:
        return out
    for row in facts[tag]["units"]["USD"]:
        if row.get("form") != "10-K" or not row.get("start") or not row.get("end"):
            continue
        start = datetime.date(*map(int, row["start"].split("-")))
        end = datetime.date(*map(int, row["end"].split("-")))
        if end.month == 12 and 350 <= (end - start).days <= 370:
            out[end.year] = row["val"] / 1e6      # -> $ millions
    return out


def fetch_ibm_interest():
    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{CIK}.json"
    req = urllib.request.Request(url, headers=SEC_HEADERS)
    facts = json.loads(urllib.request.urlopen(req, timeout=60).read())["facts"]["us-gaap"]
    return (annual_from_xbrl(facts, "InterestCostsIncurred"),
            annual_from_xbrl(facts, "InterestPaidNet"))


def fetch_tenor(symbol):
    """Annual mean of monthly closes for one Yahoo yield index."""
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           "?period1=0&period2=9999999999&interval=1mo")
    req = urllib.request.Request(url, headers=YAHOO_HEADERS)
    result = json.loads(urllib.request.urlopen(req, timeout=30).read())["chart"]["result"][0]
    closes = result["indicators"]["quote"][0]["close"]
    by_year = collections.defaultdict(list)
    for stamp, close in zip(result["timestamp"], closes):
        if close is None:
            continue
        year = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).year
        by_year[year].append(close)
    # >=6 months of data before a year is allowed to stand as an annual average
    return {y: round(sum(v) / len(v), 2) for y, v in by_year.items() if len(v) >= 6}


def main():
    print("Fetching IBM interest costs from SEC EDGAR XBRL ...")
    incurred, paid = fetch_ibm_interest()
    print(f"  InterestCostsIncurred: {min(incurred)}-{max(incurred)} ({len(incurred)} years)")
    print(f"  InterestPaidNet:       {min(paid)}-{max(paid)} ({len(paid)} years)")

    with open(FINANCIALS_IN, encoding="utf-8") as fh:
        financials = json.load(fh)
    total_debt = {e["year"]: e.get("totalDebt") for e in financials["years"]}

    cost_of_debt, avg_debt, cross_check = {}, {}, {}
    for year in sorted(incurred):
        prev, cur = total_debt.get(year - 1), total_debt.get(year)
        if not prev or not cur:
            continue                      # no averageable debt balance -> skip
        avg = (prev + cur) / 2
        avg_debt[year] = round(avg, 1)
        cost_of_debt[year] = round(incurred[year] / avg * 100, 2)
        if year in paid:
            cross_check[year] = round(paid[year] / avg * 100, 2)

    # Guard the tag choice: if InterestPaidNet ever drifts far from
    # InterestCostsIncurred, the series is no longer measuring what the
    # docstring claims and should not be published silently.
    drift = {y: round(abs(cost_of_debt[y] - cross_check[y]), 2)
             for y in cross_check if abs(cost_of_debt[y] - cross_check[y]) > 0.75}
    if drift:
        raise SystemExit(f"ABORT: cost-of-debt disagrees with cash interest paid by >0.75pp: {drift}")

    print("Fetching Treasury curve from Yahoo Finance ...")
    treasury, tenor_labels = {}, {}
    for symbol, key, label in TENORS:
        series = fetch_tenor(symbol)
        treasury[key] = {str(y): v for y, v in sorted(series.items())}
        tenor_labels[key] = label
        print(f"  {key:>3}: {min(series)}-{max(series)} ({len(series)} years)")

    payload = {
        "generated": datetime.date.today().isoformat(),
        "note": ("IBM effective cost of debt = interest costs incurred / average total debt. "
                 "This is a realised book rate across IBM's whole debt stack, NOT the market "
                 "yield on IBM bonds -- it reprices only as old issues mature and refinance, "
                 "so it lags market rates by design. Treasury figures are annual means of "
                 "monthly closes, matching the full-year basis of the IBM series."),
        "sources": {
            "ibmCostOfDebt": ("SEC EDGAR XBRL us-gaap:InterestCostsIncurred (IBM total interest "
                              "cost, includes financing-segment interest charged to cost of "
                              "financing) / average total debt from pipeline/data/financials.json "
                              "(hand-verified 10-K balance sheets)"),
            "ibmCostOfDebtCashCheck": ("SEC EDGAR XBRL us-gaap:InterestPaidNet / same average debt "
                                       "-- independent cross-check, agrees within 0.75pp by assertion"),
            "treasury": ("Yahoo Finance ^IRX / ^FVX / ^TNX / ^TYX, annual mean of monthly closes. "
                         "Distinct from macro.treasury10yr, which is a Jan-1 point reading"),
        },
        "tenorLabels": tenor_labels,
        "ibmCostOfDebt": {str(y): v for y, v in sorted(cost_of_debt.items())},
        "ibmCostOfDebtCashCheck": {str(y): v for y, v in sorted(cross_check.items())},
        "ibmInterestIncurredM": {str(y): round(incurred[y], 1) for y in sorted(cost_of_debt)},
        "ibmAvgTotalDebtM": {str(y): v for y, v in sorted(avg_debt.items())},
        "treasury": treasury,
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")

    years = sorted(cost_of_debt)
    print(f"\nWrote {OUT}")
    print(f"IBM cost of debt: {years[0]}-{years[-1]}")
    ten = treasury["10y"]
    print("\nyear  IBM%   10y%   spread")
    for y in years:
        t = ten.get(str(y))
        spread = f"{cost_of_debt[y] - t:+.2f}" if t is not None else "  n/a"
        print(f"{y}  {cost_of_debt[y]:5.2f}  {t if t is not None else float('nan'):5.2f}   {spread}")


if __name__ == "__main__":
    main()
