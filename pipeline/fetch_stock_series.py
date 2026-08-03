"""
fetch_stock_series.py
=====================
Builds the five macro.* series that Section A of the Macro vs IBM tab needs:

    ibmTotalReturn      calendar-year total return %, dividends reinvested
    sp500TotalReturn    same basis, for the S&P 500
    ibmDividendYield    dividends paid in the year / year-end close, %
    ibmBeta5yr          60-month beta of IBM vs the S&P 500, measured at Dec 31
    ibmAvgDailyVolume   mean daily share volume for the year, millions

WHY THIS EXISTS
buildStockPerformanceCharts() in app.js opens with

    if (!monthly || !ibmTR || !sp5TR || !divYld || !vol || !beta) return;

and NONE of those five series had ever been added to the dataset. So the guard
fired on every load and the whole of Section A — the KPI bar, the "IBM vs
Market: Total Return & Outperformance" chart, and (before it was replaced) the
dividend/volume/beta card — rendered as empty boxes on the live site. This
script sources them so the section actually works.

BASIS — total return, not price return.
IBM's series uses Yahoo's ADJUSTED close, which reinvests dividends and adjusts
for splits. The S&P side uses ^SP500TR, the official S&P 500 Total Return
index, for the same reason. Comparing a dividend-adjusted IBM against a
price-only index would overstate IBM's relative performance by roughly the
index's dividend yield each year — the exact error that
fetch_sp500tr_benchmark.py was written to correct on the M&A tab. Do not
"simplify" either side to ^GSPC or macro.sp500YearEnd.

Beta is a 60-month ordinary least-squares regression of IBM's monthly total
returns on the index's, recomputed at each year end; years without a full 60
months of history behind them are omitted rather than computed on a short
window.

Coverage note: Yahoo's unauthenticated API caps daily history at ~40 years, so
ibmAvgDailyVolume starts later than the monthly-derived series. Each output
series carries its own year range; the site must not assume they align.

Sources: Yahoo Finance IBM (adjusted close, volume, dividend events) and
         ^SP500TR (S&P 500 Total Return index).

Output: pipeline/data/stock_series.json
Run:    python pipeline/fetch_stock_series.py      (needs internet access)
"""
import os
import json
import datetime
import collections
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "pipeline", "data")
OUT = os.path.join(DATA_DIR, "stock_series.json")

HEADERS = {"User-Agent": "Mozilla/5.0"}


def _fetch(symbol, interval, events=""):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/{symbol}"
           f"?period1=0&period2=9999999999&interval={interval}")
    if events:
        url += f"&events={events}"
    req = urllib.request.Request(url, headers=HEADERS)
    return json.loads(urllib.request.urlopen(req, timeout=45).read())["chart"]["result"][0]


def _year(stamp):
    return datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).year


def monthly_adjclose(symbol):
    """Year-end adjusted close per calendar year (dividends reinvested)."""
    res = _fetch(symbol, "1mo")
    stamps = res["timestamp"]
    try:
        series = res["indicators"]["adjclose"][0]["adjclose"]
    except (KeyError, IndexError):
        series = res["indicators"]["quote"][0]["close"]   # ^SP500TR carries no adjclose
    by_year, monthly = {}, []
    for stamp, val in zip(stamps, series):
        if val is None:
            continue
        by_year[_year(stamp)] = val        # later months overwrite -> ends on December
        monthly.append((stamp, val))
    return by_year, monthly


def annual_total_return(year_end):
    """Year-over-year % change of a dividend-reinvested index level."""
    out = {}
    for year in sorted(year_end):
        prev = year_end.get(year - 1)
        if prev:
            out[year] = round((year_end[year] / prev - 1) * 100, 2)
    return out


def monthly_returns(monthly):
    """[(year, month_return_fraction)] from a monthly level series."""
    out = []
    for i in range(1, len(monthly)):
        prev, cur = monthly[i - 1][1], monthly[i][1]
        if prev:
            out.append((_year(monthly[i][0]), cur / prev - 1))
    return out


def rolling_beta(ibm_monthly, idx_monthly, window=60):
    """60-month OLS beta of IBM on the index, evaluated at each year end."""
    ibm_r, idx_r = monthly_returns(ibm_monthly), monthly_returns(idx_monthly)
    idx_by_len = min(len(ibm_r), len(idx_r))
    ibm_r, idx_r = ibm_r[-idx_by_len:], idx_r[-idx_by_len:]

    out = {}
    for end in range(window, len(ibm_r) + 1):
        year = ibm_r[end - 1][0]
        xs = [idx_r[i][1] for i in range(end - window, end)]
        ys = [ibm_r[i][1] for i in range(end - window, end)]
        mx, my = sum(xs) / window, sum(ys) / window
        var = sum((x - mx) ** 2 for x in xs)
        if var == 0:
            continue
        cov = sum((xs[i] - mx) * (ys[i] - my) for i in range(window))
        out[year] = round(cov / var, 2)    # later windows overwrite -> Dec 31 value
    return out


def dividend_yield(year_end_close):
    """Dividends paid during the year / that year's closing price, %."""
    res = _fetch("IBM", "1d", events="div")
    divs = collections.defaultdict(float)
    for payment in (res.get("events", {}).get("dividends") or {}).values():
        divs[_year(payment["date"])] += payment["amount"]
    return {y: round(total / year_end_close[y] * 100, 2)
            for y, total in sorted(divs.items())
            if year_end_close.get(y)}


def avg_daily_volume():
    res = _fetch("IBM", "1d")
    by_year = collections.defaultdict(list)
    for stamp, vol in zip(res["timestamp"], res["indicators"]["quote"][0]["volume"]):
        if vol:
            by_year[_year(stamp)].append(vol)
    # >=120 sessions before a year counts as a full year's average
    return {y: round(sum(v) / len(v) / 1e6, 2)
            for y, v in sorted(by_year.items()) if len(v) >= 120}


def main():
    print("Fetching IBM (adjusted close, dividends reinvested) ...")
    ibm_ye, ibm_monthly = monthly_adjclose("IBM")
    print(f"  {min(ibm_ye)}-{max(ibm_ye)}")

    print("Fetching ^SP500TR (S&P 500 Total Return) ...")
    sp_ye, sp_monthly = monthly_adjclose("%5ESP500TR")
    print(f"  {min(sp_ye)}-{max(sp_ye)}")

    ibm_tr = annual_total_return(ibm_ye)
    sp_tr = annual_total_return(sp_ye)

    # Price series for the dividend-yield denominator must be the UNADJUSTED
    # close: dividing a dividend by a dividend-adjusted price would understate
    # the historical yield, because adjustment scales old prices downward.
    raw = _fetch("IBM", "1mo")
    raw_ye = {}
    for stamp, close in zip(raw["timestamp"], raw["indicators"]["quote"][0]["close"]):
        if close is not None:
            raw_ye[_year(stamp)] = close

    print("Deriving dividend yield, beta and volume ...")
    div_yld = dividend_yield(raw_ye)
    beta = rolling_beta(ibm_monthly, sp_monthly)
    volume = avg_daily_volume()

    common = sorted(set(ibm_tr) & set(sp_tr))
    payload = {
        "generated": datetime.date.today().isoformat(),
        "note": ("Total returns are dividend-reinvested on BOTH sides: IBM from Yahoo's "
                 "adjusted close, the index from ^SP500TR (the official S&P 500 Total "
                 "Return index). Beta is a 60-month OLS regression of IBM's monthly "
                 "total returns on the index's, measured at each Dec 31; years without a "
                 "full 60-month history are omitted. Dividend yield divides dividends "
                 "paid in the year by that year's UNADJUSTED closing price. Series do not "
                 "all start in the same year — Yahoo caps daily history at ~40 years."),
        "sources": {
            "ibmTotalReturn": "Yahoo Finance IBM monthly adjusted close, year-over-year change",
            "sp500TotalReturn": "Yahoo Finance ^SP500TR monthly close, year-over-year change",
            "ibmDividendYield": "Yahoo Finance IBM dividend events / unadjusted year-end close",
            "ibmBeta5yr": "60-month OLS beta of IBM monthly total returns vs ^SP500TR, at Dec 31",
            "ibmAvgDailyVolume": "Yahoo Finance IBM daily volume, annual mean, millions of shares",
        },
        "ibmTotalReturn": {str(y): ibm_tr[y] for y in sorted(ibm_tr)},
        "sp500TotalReturn": {str(y): sp_tr[y] for y in sorted(sp_tr)},
        "ibmDividendYield": {str(y): v for y, v in sorted(div_yld.items())},
        "ibmBeta5yr": {str(y): v for y, v in sorted(beta.items())},
        "ibmAvgDailyVolume": {str(y): v for y, v in sorted(volume.items())},
    }

    with open(OUT, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1)
        fh.write("\n")

    print(f"\nWrote {OUT}")
    for key in ("ibmTotalReturn", "sp500TotalReturn", "ibmDividendYield",
                "ibmBeta5yr", "ibmAvgDailyVolume"):
        ks = sorted(payload[key])
        print(f"  {key:18} {ks[0]}-{ks[-1]}  (n={len(ks)})")

    print("\nyear   IBM TR%   S&P TR%   diff")
    for y in common[-12:]:
        print(f"{y}  {ibm_tr[y]:8.2f}  {sp_tr[y]:8.2f}  {ibm_tr[y]-sp_tr[y]:+7.2f}")


if __name__ == "__main__":
    main()
