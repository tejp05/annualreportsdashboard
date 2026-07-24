"""
fetch_benchmark_monthly.py
==========================
Fetch monthly closing prices for the two M&A-tab benchmarks and cache them
locally so the per-deal stock-performance window can be computed offline:

  XLK   -- S&P 500 Technology Select Sector ETF (benchmark for deals closing
           Dec 1998 onward; XLK inception is Dec 1998)
  ^GSPC -- S&P 500 index (benchmark for pre-1999 deals)

IBM prices are NOT fetched here -- they already live in the repo
(Story Mode/ibm_daily_prices.js, daily adjusted close). Only the benchmark
series is missing locally, so this is the single network dependency.

Output: pipeline/data/benchmark_monthly.json  { "XLK": {YYYY-MM: close}, "^GSPC": {...} }
Matches the original method: yfinance interval="1mo", auto_adjust=True.
"""
import json
from datetime import date
from pathlib import Path
import yfinance as yf

OUT = Path(__file__).parent / "data" / "benchmark_monthly.json"
START = "1984-01-01"
END = date.today().isoformat()


def fetch_monthly(ticker):
    raw = yf.download(ticker, start=START, end=END, interval="1mo",
                      auto_adjust=True, progress=False)
    out = {}
    if raw.empty:
        return out
    for idx, row in raw.iterrows():
        key = idx.strftime("%Y-%m")
        close = row["Close"]
        if hasattr(close, "item"):
            close = close.item()
        if close and close == close:  # not NaN
            out[key] = round(float(close), 4)
    return out


def main():
    result = {}
    for ticker in ("XLK", "^GSPC"):
        print(f"Fetching {ticker} monthly {START} -> {END} ...")
        series = fetch_monthly(ticker)
        print(f"  {len(series)} months  ({min(series)} .. {max(series)})" if series else "  EMPTY")
        result[ticker] = series
    OUT.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\nWrote {OUT}")


if __name__ == "__main__":
    main()
