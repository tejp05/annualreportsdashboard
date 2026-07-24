"""
Fetch monthly closing prices for IBM, XLK (S&P 500 Tech ETF), and ^GSPC (S&P 500)
and compute T-6 to T+18 deal windows for every M&A deal in ma.json.

XLK only goes back to Dec 1998, so the 3 pre-1999 deals (ROLM 1984, Lotus 1995,
Tivoli 1996) fall back to ^GSPC as the benchmark.

Output: pipeline/data/monthly_prices.json
Run:    python pipeline/fetch_monthly_prices.py
"""
import json
import os
from datetime import date, datetime
from dateutil.relativedelta import relativedelta
import yfinance as yf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MA_PATH   = os.path.join(ROOT, "pipeline", "data", "ma.json")
OUT_PATH  = os.path.join(ROOT, "pipeline", "data", "monthly_prices.json")

XLK_START = date(1998, 12, 1)   # XLK inception

# ── helpers ──────────────────────────────────────────────────────────────────

def fetch_monthly(ticker, start, end):
    """Return {YYYY-MM: close} dict for a ticker between start and end dates."""
    raw = yf.download(ticker, start=start.isoformat(), end=end.isoformat(),
                      interval="1mo", auto_adjust=True, progress=False)
    if raw.empty:
        return {}
    result = {}
    for idx, row in raw.iterrows():
        key = idx.strftime("%Y-%m") if hasattr(idx, "strftime") else str(idx)[:7]
        close = row["Close"]
        if hasattr(close, "item"):
            close = close.item()
        if close and close == close:   # not NaN
            result[key] = round(float(close), 4)
    return result

def price_at(prices, target_date):
    """Find the closest monthly price at or just before target_date."""
    key = target_date.strftime("%Y-%m")
    if key in prices:
        return prices[key], key
    # walk back up to 2 months
    for delta in range(1, 3):
        d2 = target_date - relativedelta(months=delta)
        k2 = d2.strftime("%Y-%m")
        if k2 in prices:
            return prices[k2], k2
    return None, None

def monthly_series(prices, start_date, end_date):
    """Return list of {month, price} between two dates (inclusive)."""
    out = []
    cur = date(start_date.year, start_date.month, 1)
    end = date(end_date.year, end_date.month, 1)
    while cur <= end:
        key = cur.strftime("%Y-%m")
        if key in prices:
            out.append({"month": key, "price": prices[key]})
        cur += relativedelta(months=1)
    return out

def pct(base, end_val):
    if base and end_val:
        return round((end_val - base) / base * 100, 2)
    return None


# ── main ─────────────────────────────────────────────────────────────────────

def main():
    with open(MA_PATH, encoding="utf-8") as f:
        ma = json.load(f)

    deals = [d for d in ma["deals"] if d.get("closeDate")]

    # Date range: earliest T-6 to latest T+18
    close_dates = []
    for d in deals:
        raw = d["closeDate"]
        if len(raw) == 7:   # YYYY-MM
            close_dates.append(date(int(raw[:4]), int(raw[5:7]), 1))
        else:
            close_dates.append(date.fromisoformat(raw))

    fetch_start = min(close_dates) - relativedelta(months=8)   # little buffer
    fetch_end   = max(close_dates) + relativedelta(months=20)
    if fetch_end > date.today():
        fetch_end = date.today()

    print(f"Fetching IBM  {fetch_start} → {fetch_end}")
    ibm_prices = fetch_monthly("IBM", fetch_start, fetch_end)
    print(f"  {len(ibm_prices)} months")

    print(f"Fetching XLK  {fetch_start} → {fetch_end}")
    xlk_prices = fetch_monthly("XLK", fetch_start, fetch_end)
    print(f"  {len(xlk_prices)} months")

    print(f"Fetching ^GSPC {fetch_start} → {fetch_end}")
    sp_prices = fetch_monthly("^GSPC", fetch_start, fetch_end)
    print(f"  {len(sp_prices)} months")

    deal_windows = []
    for deal, close in zip(deals, close_dates):
        t_minus6  = close - relativedelta(months=6)
        t_plus18  = close + relativedelta(months=18)
        if t_plus18 > date.today():
            t_plus18 = date.today()

        # choose benchmark
        use_xlk = close >= XLK_START
        bench_prices = xlk_prices if use_xlk else sp_prices
        bench_label  = "XLK" if use_xlk else "S&P 500"

        ibm_base,   ibm_base_mo   = price_at(ibm_prices,   t_minus6)
        ibm_end,    ibm_end_mo    = price_at(ibm_prices,   t_plus18)
        bench_base, bench_base_mo = price_at(bench_prices, t_minus6)
        bench_end,  bench_end_mo  = price_at(bench_prices, t_plus18)

        ibm_series   = monthly_series(ibm_prices,   t_minus6, t_plus18)
        bench_series = monthly_series(bench_prices, t_minus6, t_plus18)

        # index both to 100 at T-6 for easy charting
        def index_series(series, base_price):
            if not base_price:
                return series
            return [{"month": s["month"],
                     "price": round(s["price"] / base_price * 100, 4)}
                    for s in series]

        ibm_indexed   = index_series(ibm_series,   ibm_base)
        bench_indexed = index_series(bench_series, bench_base)

        ibm_return   = pct(ibm_base,   ibm_end)
        bench_return = pct(bench_base, bench_end)
        alpha = round(ibm_return - bench_return, 2) if (ibm_return is not None and bench_return is not None) else None

        deal_windows.append({
            "name":          deal["name"],
            "closeDate":     deal["closeDate"],
            "tMinus6":       t_minus6.isoformat(),
            "tPlus18":       t_plus18.isoformat(),
            "benchmark":     bench_label,
            "ibmBasePrice":  ibm_base,
            "ibmBaseMonth":  ibm_base_mo,
            "ibmEndPrice":   ibm_end,
            "ibmEndMonth":   ibm_end_mo,
            "ibmReturn":     ibm_return,
            "benchReturn":   bench_return,
            "alpha":         alpha,
            "ibmSeries":     ibm_indexed,
            "benchSeries":   bench_indexed,
        })

        if ibm_return is not None and bench_return is not None:
            status = f"IBM {ibm_return:+.1f}% vs {bench_label} {bench_return:+.1f}% => alpha {alpha:+.1f}%"
        elif ibm_return is not None:
            status = f"IBM {ibm_return:+.1f}% (no benchmark data)"
        else:
            status = "insufficient data"
        print(f"  {deal['name'][:40]:40s}  {status}")

    output = {
        "generated": date.today().isoformat(),
        "note": "Monthly prices from Yahoo Finance. IBM and benchmark indexed to 100 at T-6 months before deal close. XLK used as benchmark from Dec 1998 onward; S&P 500 (^GSPC) for earlier deals.",
        "deals": deal_windows
    }

    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT_PATH}")


if __name__ == "__main__":
    main()
