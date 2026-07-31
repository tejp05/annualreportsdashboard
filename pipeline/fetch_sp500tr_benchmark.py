"""
fetch_sp500tr_benchmark.py
===========================
Build a proper TOTAL-RETURN S&P 500 series (dividends reinvested) for the
M&A tab's pre-1999 benchmark, replacing the price-only ^GSPC / macro.sp500YearEnd
series that was being compared against IBM's own dividend-adjusted return.

Why this exists: IBM's return series (Story Mode/ibm_daily_prices.js) is
Yahoo's adjusted close -- dividends reinvested, splits adjusted. Comparing
that against ^GSPC (a price-only index; Yahoo has no dividend data for a
bare index ticker) or macro.sp500YearEnd overstates IBM's alpha for every
deal/era benchmarked before 1999, by roughly the S&P 500's dividend yield
compounded over the window (~13-15pp over a 2-year window in the 1980s).

Two data sources, chain-linked into one continuous series:
  1988 onward : Yahoo's ^SP500TR ticker -- the REAL, official S&P 500 Total
                Return index. Daily data confirmed back to 1988-01-04.
  1983-1987   : ^SP500TR doesn't reach this far back. Reconstructed from
                Robert Shiller's (Yale) monthly S&P Composite price + trailing
                dividend dataset (pipeline/data/shiller_sp500_1982_1988.json),
                using the standard monthly total-return approximation:
                  monthly return = (P_t + D_t/12) / P_(t-1)
                compounded into an index, then CHAIN-LINKED to the real
                ^SP500TR series by rescaling with the average ratio of the
                two series across all 12 overlapping months of 1988 (both
                series exist that year, so the overlap validates the splice).
                This is a reconstruction, not a raw index pull -- every UI
                surface that uses the pre-1988 portion says so explicitly.

Output:
  pipeline/data/ma_sp500tr_monthly.json   -- full monthly series, 1983-present
  pipeline/data/ma_sp500tr_yearend.json   -- year-end (M&A era-drawer benchmark,
                                             matches ma_xlk_adjusted.json's shape)

Used ONLY by the M&A tab (era-drawer CAGR benchmark, and hand-verified into
specific maPerformance.deals entries in data.js for the ROLM / Lotus / Tivoli
per-deal 2-year windows). Does not touch macro.json's sp500YearEnd, which
still feeds the Macro vs IBM tab unchanged.

Run: python pipeline/fetch_sp500tr_benchmark.py   (needs internet access)
"""
import os
import json
import datetime
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "pipeline", "data")
SHILLER_IN = os.path.join(DATA_DIR, "shiller_sp500_1982_1988.json")
OUT_MONTHLY = os.path.join(DATA_DIR, "ma_sp500tr_monthly.json")
OUT_YEAREND = os.path.join(DATA_DIR, "ma_sp500tr_yearend.json")
HEADERS = {"User-Agent": "Mozilla/5.0"}


def fetch_sp500tr_daily():
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/%5ESP500TR"
           "?period1=567993600&period2=9999999999&interval=1d&events=history")
    req = urllib.request.Request(url, headers=HEADERS)
    raw = json.loads(urllib.request.urlopen(req, timeout=30).read())
    result = raw["chart"]["result"][0]
    ts = result["timestamp"]
    close = result["indicators"]["quote"][0]["close"]
    daily = {}
    for t, c in zip(ts, close):
        if c is None:
            continue
        d = datetime.datetime.utcfromtimestamp(t).strftime("%Y-%m-%d")
        daily[d] = round(c, 4)
    return daily


def collapse_to_monthly(daily):
    """Later day in each month overwrites -> last-trading-day close."""
    monthly = {}
    for d in sorted(daily):
        monthly[d[:7]] = daily[d]
    return monthly


def reconstruct_shiller_index(shiller_monthly, start="1982-01", end="1988-12"):
    """Monthly total-return index (base=100 at `start`) from Shiller P/D,
    using monthly return ~= (P_t + D_t/12) / P_(t-1)."""
    months = sorted(k for k in shiller_monthly if start <= k <= end)
    idx = {months[0]: 100.0}
    for i in range(1, len(months)):
        prev_k, cur_k = months[i - 1], months[i]
        p_prev = shiller_monthly[prev_k]["P"]
        p_cur, d_cur = shiller_monthly[cur_k]["P"], shiller_monthly[cur_k]["D"]
        idx[cur_k] = idx[prev_k] * (p_cur + d_cur / 12) / p_prev
    return idx


def chain_link(shiller_idx, real_monthly, overlap_year="1988"):
    """Rescale the Shiller index to the real series' level using the average
    ratio across every month both series have in the overlap year, then
    splice: Shiller (rescaled) before the overlap, real series from then on."""
    overlap_months = [f"{overlap_year}-{m:02d}" for m in range(1, 13)]
    ratios = [real_monthly[k] / shiller_idx[k] for k in overlap_months
              if k in real_monthly and k in shiller_idx]
    scale = sum(ratios) / len(ratios)

    combined = {k: round(v * scale, 4) for k, v in shiller_idx.items() if k < f"{overlap_year}-01"}
    combined.update(real_monthly)
    return combined, scale, len(ratios)


def year_end_series(monthly):
    by_year = {}
    for k, v in monthly.items():
        y, m = int(k[:4]), int(k[5:7])
        if y not in by_year or m > by_year[y][0]:
            by_year[y] = (m, v)
    return {str(y): v[1] for y, v in sorted(by_year.items())}


def main():
    print("Fetching ^SP500TR daily history from Yahoo Finance...")
    daily = fetch_sp500tr_daily()
    real_monthly = collapse_to_monthly(daily)
    print(f"  {len(daily)} daily points, {len(real_monthly)} months, "
          f"{min(real_monthly)} .. {max(real_monthly)}")

    shiller_raw = json.load(open(SHILLER_IN, encoding="utf-8"))["monthly"]
    shiller_idx = reconstruct_shiller_index(shiller_raw)

    combined, scale, n_overlap = chain_link(shiller_idx, real_monthly)
    print(f"  Chain-link scale factor: {scale:.4f} (avg of {n_overlap} overlapping "
          f"months in 1988)")

    year_end = year_end_series(combined)
    # Only 1983-2002 is ever read by the app (Pre-Gerstner + Gerstner eras;
    # 1999+ deals already use the real dividend-adjusted XLK series instead).
    year_end_trimmed = {y: v for y, v in year_end.items() if "1983" <= y <= "2002"}

    monthly_out = {
        "generated": datetime.date.today().isoformat(),
        "method": ("1988 onward: Yahoo Finance ^SP500TR (official S&P 500 Total "
                   "Return index), daily close collapsed to last trading day of "
                   "month. 1983-1987: reconstructed from Robert Shiller's (Yale) "
                   "monthly S&P Composite price + trailing dividend dataset, "
                   "monthly return = (P_t + D_t/12)/P_(t-1) compounded into an "
                   f"index, then chain-linked to the real ^SP500TR series via a "
                   f"{scale:.4f}x rescale (average ratio across all 12 overlapping "
                   "months of 1988)."),
        "note": ("M&A-tab-only. Used to correct the pre-1999 benchmark for ROLM "
                 "(1984), Lotus (1995), and Tivoli (1996), and the Pre-Gerstner / "
                 "Gerstner era-drawer CAGR benchmark. Does not touch macro.json's "
                 "sp500YearEnd (price-only), which still feeds the Macro vs IBM tab."),
        "series": combined,
    }
    yearend_out = {
        "generated": datetime.date.today().isoformat(),
        "sp500TRYearEnd": year_end_trimmed,
        "source": monthly_out["method"],
        "note": monthly_out["note"],
    }

    json.dump(monthly_out, open(OUT_MONTHLY, "w", encoding="utf-8"), indent=1)
    json.dump(yearend_out, open(OUT_YEAREND, "w", encoding="utf-8"), indent=1)
    print(f"-> {OUT_MONTHLY}")
    print(f"-> {OUT_YEAREND}")


if __name__ == "__main__":
    main()
