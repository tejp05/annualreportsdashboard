"""Export the canonical pipeline data into the website as a plain JS file.

The website is a zero-build static site. To keep it working even when opened
directly from disk (file://, no server, no CORS), we don't fetch JSON at runtime
-- we bake the data into `website/data.js` as a global `window.IBM_DATA`.

Run this whenever the pipeline data changes:
    python pipeline/export_web.py

Source of truth stays in pipeline/data/*.json; this is a one-way publish step.
"""
import os
import json
import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "pipeline", "data")
OUT = os.path.join(ROOT, "data.js")  # site now lives at the repo root

# Per-year fields the site uses (kept explicit so the contract is obvious).
# marketCap is NOT in the annual reports (it is share price x shares, i.e. market
# data). The field is carried here so the site has a slot for it; it is null until
# a sourced stock-price series is added (see pipeline/README).
FIELDS = ["year", "revenue", "netIncome", "epsDiluted", "epsBasic",
          "dividendsPerShare", "totalAssets", "stockholdersEquity",
          "rdExpense", "employees", "marketCap",
          # inputs for the derived-metrics table
          "pretaxIncome", "incomeTaxes", "freeCashFlow", "operatingCashFlow",
          "capitalExpenditure", "totalDebt", "softwareARR",
          # latest share count, used client-side to turn a live quote into a
          # live market-cap *estimate* (clearly distinguished from the
          # filing-sourced marketCap series above)
          "sharesOutstandingM"]


def load(name):
    with open(os.path.join(DATA, name), encoding="utf-8") as f:
        return json.load(f)


# Years where freeCashFlow/operatingCashFlow/capitalExpenditure were read directly
# in a full-sentence context and cross-checked against a second report's restated
# figure (not just a regex pattern match). Everything else from cashflow.json was
# extracted by pattern-matching only and has NOT been individually verified --
# one such value (2014 FCF) was already found to be wrong by $5.5B before being
# caught and fixed. See pipeline/cashflow.py header for the extraction method.
VERIFIED_CASHFLOW = {
    # OCF + CapEx read directly from the consolidated cash flow statement; each figure
    # cross-validated against the prior-year column in the subsequent year's filing.
    # FCF = OCF - net CapEx (gross CapEx - proceeds from asset disposals); proceeds
    # verified from the same cash flow statement. Per IBM 2015 10-K definition.
    ("1995", "operatingCashFlow"), ("1995", "capitalExpenditure"), ("1995", "freeCashFlow"),
    ("1996", "operatingCashFlow"), ("1996", "capitalExpenditure"), ("1996", "freeCashFlow"),
    ("1997", "operatingCashFlow"), ("1997", "capitalExpenditure"), ("1997", "freeCashFlow"),
    ("1998", "operatingCashFlow"), ("1998", "capitalExpenditure"), ("1998", "freeCashFlow"),
    ("1999", "operatingCashFlow"), ("1999", "capitalExpenditure"), ("1999", "freeCashFlow"),
    ("2000", "operatingCashFlow"), ("2000", "capitalExpenditure"), ("2000", "freeCashFlow"),
    ("2001", "operatingCashFlow"), ("2001", "capitalExpenditure"), ("2001", "freeCashFlow"),
    ("2002", "operatingCashFlow"), ("2002", "capitalExpenditure"), ("2002", "freeCashFlow"),
    ("2003", "freeCashFlow"),
    ("2004", "capitalExpenditure"), ("2004", "freeCashFlow"),
    ("2005", "capitalExpenditure"),
    ("2007", "freeCashFlow"),
    ("2011", "freeCashFlow"),
    ("2013", "freeCashFlow"),
    ("2014", "freeCashFlow"),
    ("2015", "freeCashFlow"),
    ("2016", "freeCashFlow"),
    ("2017", "freeCashFlow"), ("2017", "capitalExpenditure"),
    ("2018", "freeCashFlow"), ("2018", "capitalExpenditure"),
    ("2021", "freeCashFlow"),
    ("2024", "freeCashFlow"),
    ("2025", "freeCashFlow"),
}


def main():
    fin = load("financials.json")
    seg = load("segments.json")
    meta = load("metadata.json")
    mcap = load("marketcap.json")["years"]   # external market data, by year (str keys)
    macro = load("macro.json")               # GDP / CPI / S&P 500 / recessions (pipeline/macro.py)
    cashflow = load("cashflow.json")["years"]  # OCF/capex/FCF extracted from report text (pipeline/cashflow.py)
    stockprice = load("stockprice.json")["years"]  # year-end price per share, 2001-2020 only
    ma = load("ma_clean.json")                     # M&A deals, deduplicated + cross-checked (78 deals)
    monthly_prices = load("monthly_prices.json")   # IBM + benchmark monthly prices for M&A deal windows
    ma_xlk = load("ma_xlk_adjusted.json")          # dividend-adjusted XLK year-end (M&A-tab era benchmark only)

    years = [{k: y.get(k) for k in FIELDS} for y in fin["years"]]
    # market cap is not in the filings; merge in the sourced series
    for row in years:
        row["marketCap"] = mcap.get(str(row["year"]))
        yr = str(row["year"])
        row["stockPrice"] = stockprice.get(yr)
        # values already in financials.json went through the main anchors/reconcile
        # pipeline tier and are treated as verified; cashflow.json fills gaps with
        # text-pattern-matched values that are only "verified" if in the whitelist above
        fcf_from_filings = row.get("freeCashFlow") is not None   # True only when financials.json had the value
        row["freeCashFlowVerified"] = fcf_from_filings
        row["operatingCashFlowVerified"] = row.get("operatingCashFlow") is not None
        row["capitalExpenditureVerified"] = row.get("capitalExpenditure") is not None
        cf = cashflow.get(yr)
        if cf:
            for k in ("operatingCashFlow", "capitalExpenditure", "freeCashFlow"):
                if row.get(k) is None and cf.get(k) is not None:
                    row[k] = cf[k]
                    row[k + "Verified"] = (yr, k) in VERIFIED_CASHFLOW

        # Human-readable source note shown in the UI under the FCF stat card
        FCF_NOTES = {
            "md&a-exact":                  "Stated in IBM’s annual report MD&A",
            "prose-md&a":                  "Stated in IBM’s annual report MD&A",
            "explicit-billions":           "Stated in IBM’s annual report (rounded to nearest $100M)",
            "derived(ocf-capex)":          "Derived: OCF − CapEx (verified from IBM 10-K cash flow statement)",
            "derived(ocf-net-capex)":      "Derived: OCF − net CapEx (gross CapEx less asset disposal proceeds, per IBM’s FCF definition; GF receivables adjustment not applied)",
            "derived-from-2015-yoy-delta": "Derived from year-over-year delta disclosed in IBM filing",
        }
        if row.get("freeCashFlow") is not None:
            if fcf_from_filings:
                row["freeCashFlowNote"] = "Stated in IBM’s annual report"
            elif cf and cf.get("fcfSource"):
                src = cf["fcfSource"]
                is_verified = (yr, "freeCashFlow") in VERIFIED_CASHFLOW
                if src == "derived(ocf-capex)" and not is_verified:
                    row["freeCashFlowNote"] = "Derived: OCF − CapEx (inputs pattern-extracted, not individually verified)"
                else:
                    row["freeCashFlowNote"] = FCF_NOTES.get(src, "Pattern-extracted from filing text, not individually verified")
            else:
                row["freeCashFlowNote"] = "Pattern-extracted from filing text, not individually verified"
        else:
            row["freeCashFlowNote"] = None

    payload = {
        "generated": datetime.date.today().isoformat(),
        "currency": "USD_millions",
        "source": "IBM/CTR annual reports 1911-2025, parsed in pipeline/",
        "financials": years,
        "segments": seg,
        "metadata": meta,
        "macro": macro,
        "ma": ma,
        "maPerformance": monthly_prices,
        "maBenchmark": ma_xlk,
    }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("/* AUTO-GENERATED by pipeline/export_web.py -- do not edit by hand. */\n")
        f.write("window.IBM_DATA = ")
        json.dump(payload, f, ensure_ascii=False, indent=1)
        f.write(";\n")

    print(f"wrote {OUT}  ({len(years)} years, "
          f"{len(seg['years'])} segment-years, {len(meta['milestones'])} milestones)")


if __name__ == "__main__":
    main()
