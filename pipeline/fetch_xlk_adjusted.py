"""Fetch XLK's dividend-adjusted year-end close, for the M&A tab's stock-benchmark
comparison ONLY.

Why this is separate from macro.py's techYearEnd: that series uses raw close
(no dividend adjustment) and also feeds the Macro vs IBM tab's chart. Changing
it there would alter that chart's numbers. This script writes a standalone
file that only the M&A tab reads, so the Macro vs IBM tab is untouched.

Output: pipeline/data/ma_xlk_adjusted.json
Run:    python pipeline/fetch_xlk_adjusted.py   (needs internet access)
"""
import os
import json
import datetime
import urllib.request
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "pipeline", "data", "ma_xlk_adjusted.json")
HEADERS = {"User-Agent": "Mozilla/5.0"}


def fetch(url):
    req = urllib.request.Request(url, headers=HEADERS)
    return urllib.request.urlopen(req, timeout=30).read()


def get_yearend_adjusted(ticker):
    """Year-end (or latest, for in-progress year) dividend/split-adjusted close."""
    raw = fetch(
        f"https://query1.finance.yahoo.com/v8/finance/chart/{urllib.parse.quote(ticker)}"
        f"?range=max&interval=1mo&events=history&includeAdjustedClose=true"
    )
    result = json.loads(raw)["chart"]["result"][0]
    ts = result["timestamp"]
    adjclose = result["indicators"]["adjclose"][0]["adjclose"]
    by_year = {}
    for t, c in zip(ts, adjclose):
        if c is None:
            continue
        dt = datetime.datetime.utcfromtimestamp(t)
        y = dt.year
        if y not in by_year or dt.month >= by_year[y][0]:
            by_year[y] = (dt.month, round(c, 2))
    return {str(y): v[1] for y, v in by_year.items()}


def main():
    xlk_adj = get_yearend_adjusted("XLK")
    output = {
        "generated": datetime.date.today().isoformat(),
        "xlkAdjYearEnd": xlk_adj,
        "source": "Yahoo Finance XLK, dividend/split-adjusted close (adjclose), "
                   "last monthly sample of each calendar year; fund inception Dec 1998.",
        "note": "Used only by the M&A tab's era stock-performance benchmark, "
                "so it can include dividends without altering the Macro vs IBM "
                "tab's techYearEnd (raw close) chart.",
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, sort_keys=False)

    print(f"XLK adjusted years: {len(xlk_adj)} ({min(xlk_adj)}-{max(xlk_adj)})")
    print(f"-> {OUT_PATH}")


if __name__ == "__main__":
    main()
