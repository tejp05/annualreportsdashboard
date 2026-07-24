"""Pull macro-economic context series and assemble macro.json.

Sources (free, no API key required):
  - GDP (nominal, annual, $B)        FRED series GDPA      1929-2025
  - CPI-U (monthly, index)           FRED series CPIAUCSL  1947-2025 -> annual avg
  - NBER recession indicator         FRED series USREC     1854-2025 -> year ranges
  - S&P 500 (price)                  Yahoo Finance ^GSPC    1984-2025 -> year-end close
  - S&P 500 Technology (XLK)         Yahoo Finance XLK      1999-2025 -> year-end close
  - Nasdaq Composite (price)         Yahoo Finance ^IXIC    1984-2025 -> year-end close

Note: Yahoo's unauthenticated chart API caps unauthenticated history at ~40
years for index tickers regardless of requested range/interval -- ^GSPC and
^IXIC both start at 1984 here even though both indices are older. XLK starts
1999 because that's the fund's actual inception (Technology Select Sector
SPDR), not an API limit.

Output: pipeline/data/macro.json
  {
    "gdpBillionsUSD":   {"1929": 104.556, ...},   # nominal GDP, current $B
    "cpiIndex":         {"1947": 21.86, ...},     # CPI-U, annual average, 1982-84=100
    "sp500YearEnd":     {"1984": 181.18, ...},    # S&P 500 index level, year-end close
    "techYearEnd":      {"1999": 36.05, ...},     # XLK (S&P 500 Technology sector), year-end close
    "nasdaqYearEnd":    {"1984": 247.35, ...},    # Nasdaq Composite, year-end close
    "recessions": [{"start": 1929, "end": 1933, "name": "..."}, ...]  # inclusive fiscal-year ranges
  }

This is macro/market data, not IBM filing data -- it carries no provenance
requirement the way financials.json does, but every series here is sourced
from a public, citable feed (FRED / Yahoo Finance), not estimated.

Re-run: python pipeline/macro.py   (needs internet access)
"""
import os
import csv
import json
import urllib.request

from manifest import ROOT

DATA = os.path.join(ROOT, "pipeline", "data")
HEADERS = {"User-Agent": "Mozilla/5.0"}


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    return urllib.request.urlopen(req, timeout=30).read()


def fred_csv(series_id):
    """Return list of (date_str, value_or_None) from a FRED graph CSV endpoint."""
    raw = fetch(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}").decode("utf-8")
    rows = list(csv.reader(raw.splitlines()))
    out = []
    for date, val in rows[1:]:
        out.append((date, None if val in ("", ".") else float(val)))
    return out


def get_gdp_annual():
    """Nominal GDP, annual, $ billions. FRED GDPA is already annual."""
    return {d[:4]: round(v, 3) for d, v in fred_csv("GDPA") if v is not None}


def get_cpi_annual():
    """CPI-U, monthly -> annual average."""
    by_year = {}
    for d, v in fred_csv("CPIAUCSL"):
        if v is None:
            continue
        by_year.setdefault(d[:4], []).append(v)
    return {y: round(sum(vs) / len(vs), 3) for y, vs in by_year.items()}


def get_fred_annual(series_id):
    """Generic FRED monthly-or-daily series -> annual average."""
    by_year = {}
    for d, v in fred_csv(series_id):
        if v is None:
            continue
        by_year.setdefault(d[:4], []).append(v)
    return {y: round(sum(vs) / len(vs), 3) for y, vs in by_year.items()}


def get_gdp_growth_pct(gdp_by_year):
    """Nominal GDP YoY % change, derived from gdp_by_year (exact, not estimated)."""
    years = sorted(gdp_by_year, key=int)
    out = {}
    for i in range(1, len(years)):
        y0, y1 = years[i - 1], years[i]
        if int(y1) != int(y0) + 1:
            continue  # only adjacent years give a meaningful YoY rate
        out[y1] = round((gdp_by_year[y1] / gdp_by_year[y0] - 1) * 100, 3)
    return out


def get_monthly_series(ticker):
    """Full monthly close series (not just year-end). Yahoo's unauthenticated
    chart API caps history at ~40 years for index/equity tickers regardless of
    requested range."""
    import urllib.parse
    import datetime
    raw = fetch(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}?range=max&interval=1mo")
    result = json.loads(raw)["chart"]["result"][0]
    ts = result["timestamp"]
    close = result["indicators"]["quote"][0]["close"]
    out = {}
    for t, c in zip(ts, close):
        if c is None:
            continue
        dt = datetime.datetime.utcfromtimestamp(t)
        out[f"{dt.year:04d}-{dt.month:02d}"] = round(c, 4)
    return out


# Well-known recession names, keyed by NBER start year (covers the spans that
# fall inside our chart's practical range, i.e. 1929 onward). Older/19th-century
# spans are left unnamed -- the frontend falls back to "Recession" for those.
RECESSION_NAMES = {
    1929: "Great Depression",
    1937: "1937–38 Recession",
    1945: "Post-WWII Recession",
    1948: "1948–49 Recession",
    1953: "1953–54 Recession",
    1957: "1957–58 Recession",
    1960: "1960–61 Recession",
    1970: "1970 Recession",
    1973: "Oil Crisis / Stagflation",
    1980: "Volcker Recession (Double-Dip)",
    1990: "Gulf War Recession",
    2001: "Dot-Com Bust",
    2008: "Global Financial Crisis",
    2020: "COVID-19 Recession",
}


def get_recessions():
    """NBER recession indicator (monthly 0/1) -> inclusive fiscal-year ranges, named."""
    months = [(d, v) for d, v in fred_csv("USREC") if v is not None]
    years_in_recession = set()
    for d, v in months:
        if v == 1:
            years_in_recession.add(int(d[:4]))
    spans, sorted_years = [], sorted(years_in_recession)
    for y in sorted_years:
        if spans and y == spans[-1][1] + 1:
            spans[-1] = (spans[-1][0], y)
        else:
            spans.append((y, y))
    return [{"start": s, "end": e, "name": RECESSION_NAMES.get(s, "Recession")} for s, e in spans]


def get_yearend(ticker):
    """Year-end (last trading day) close via Yahoo Finance DAILY chart API.

    Use interval=1d over an explicit period range -- NOT range=max&interval=1mo.
    For long-history indices (^GSPC, ^IXIC, ^DJI) Yahoo's range=max monthly feed
    silently returns a coarse, ~2-month-misaligned series, so the sample it labels
    "December" is actually a stale value from early the following year. Daily bars
    give the true Dec-31 close and deeper history. Keep each year's last trading
    day (max timestamp) close; the in-progress year yields its latest close."""
    import urllib.parse, datetime, time
    raw = fetch(f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}"
                f"?period1=0&period2={int(time.time())}&interval=1d")
    result = json.loads(raw)["chart"]["result"][0]
    ts = result["timestamp"]
    close = result["indicators"]["quote"][0]["close"]
    by_year = {}
    for t, c in zip(ts, close):
        if c is None:
            continue
        y = datetime.datetime.utcfromtimestamp(t).year
        # keep the latest trading day (year-end) sample for each year
        if y not in by_year or t > by_year[y][0]:
            by_year[y] = (t, round(c, 2))
    return {str(y): v[1] for y, v in by_year.items()}


def get_ibm_debt_series():
    """Long/short-term debt split, derived exactly from financials.json (already
    hand-verified). Short-term = totalDebt - longTermDebt for years both are
    stated; interest expense is NOT captured anywhere in the pipeline yet, so
    it is deliberately omitted here rather than estimated."""
    fin_path = os.path.join(DATA, "financials.json")
    with open(fin_path, encoding="utf-8") as f:
        fin = json.load(f)
    lt, st = {}, {}
    for row in fin["years"]:
        y = str(row["year"])
        if row.get("longTermDebt") is not None:
            lt[y] = row["longTermDebt"]
        if row.get("totalDebt") is not None and row.get("longTermDebt") is not None:
            st[y] = round(row["totalDebt"] - row["longTermDebt"], 3)
    return lt, st


def main():
    gdp = get_gdp_annual()
    ibm_lt_debt, ibm_st_debt = get_ibm_debt_series()
    macro = {
        "gdpBillionsUSD": gdp,
        "gdpGrowthPct": get_gdp_growth_pct(gdp),
        "cpiIndex": get_cpi_annual(),
        "fedFundsRate": get_fred_annual("FEDFUNDS"),
        "unemploymentRate": get_fred_annual("UNRATE"),
        "sp500YearEnd": get_yearend("^GSPC"),
        "techYearEnd": get_yearend("XLK"),
        "nasdaqYearEnd": get_yearend("^IXIC"),
        "djiaYearEnd": get_yearend("^DJI"),
        "ibmMonthlyPrice": get_monthly_series("IBM"),
        "ibmLongTermDebt": ibm_lt_debt,
        "ibmShortTermDebt": ibm_st_debt,
        "recessions": get_recessions(),
        "sources": {
            "gdpBillionsUSD": "FRED GDPA (nominal GDP, annual, $B, NSA)",
            "gdpGrowthPct": "Derived: YoY % change of gdpBillionsUSD",
            "cpiIndex": "FRED CPIAUCSL (CPI-U, monthly, annual avg, 1982-84=100)",
            "fedFundsRate": "FRED FEDFUNDS (effective federal funds rate, monthly, annual avg)",
            "unemploymentRate": "FRED UNRATE (civilian unemployment rate, monthly, annual avg)",
            "sp500YearEnd": "Yahoo Finance ^GSPC, last monthly close of each calendar year",
            "techYearEnd": "Yahoo Finance XLK (Technology Select Sector SPDR), last monthly close of each calendar year; fund inception 1998",
            "nasdaqYearEnd": "Yahoo Finance ^IXIC (Nasdaq Composite), last monthly close of each calendar year",
            "djiaYearEnd": "Yahoo Finance ^DJI (Dow Jones Industrial Average), last monthly close of each calendar year",
            "ibmMonthlyPrice": "Yahoo Finance IBM, monthly close (not split/dividend-adjusted); Yahoo unauthenticated API caps history at ~40 years",
            "ibmLongTermDebt": "Derived from pipeline/data/financials.json (IBM 10-K balance sheet, hand-verified)",
            "ibmShortTermDebt": "Derived: financials.json totalDebt minus longTermDebt, years where both are stated",
            "recessions": "FRED USREC (NBER-based recession indicator), inclusive year spans",
        },
    }
    os.makedirs(DATA, exist_ok=True)
    out_path = os.path.join(DATA, "macro.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(macro, f, indent=2, sort_keys=False)

    print(f"GDP years:    {len(macro['gdpBillionsUSD'])}  "
          f"({min(macro['gdpBillionsUSD'])}-{max(macro['gdpBillionsUSD'])})")
    print(f"CPI years:    {len(macro['cpiIndex'])}  "
          f"({min(macro['cpiIndex'])}-{max(macro['cpiIndex'])})")
    print(f"S&P500 years: {len(macro['sp500YearEnd'])}  "
          f"({min(macro['sp500YearEnd'])}-{max(macro['sp500YearEnd'])})")
    print(f"XLK years:    {len(macro['techYearEnd'])}  "
          f"({min(macro['techYearEnd'])}-{max(macro['techYearEnd'])})")
    print(f"Nasdaq years: {len(macro['nasdaqYearEnd'])}  "
          f"({min(macro['nasdaqYearEnd'])}-{max(macro['nasdaqYearEnd'])})")
    print(f"Recessions:   {len(macro['recessions'])} spans")
    print(f"-> {out_path}")


if __name__ == "__main__":
    main()
