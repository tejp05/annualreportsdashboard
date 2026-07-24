"""
build_ma_performance.py
=======================
Compute the T-6 -> T+18 month stock-performance window for EVERY M&A deal
that has a close date, using:

  IBM       -- local daily adjusted close (Story Mode/ibm_daily_prices.js),
               collapsed to a month-end close series. No network.
  Benchmark -- local monthly cache (pipeline/data/benchmark_monthly.json):
               XLK for deals closing Dec 1998+, ^GSPC (S&P 500) before that.

Method matches the original monthly_prices.json exactly: both IBM and the
benchmark are indexed to 100 at T-6; total return is (end/base - 1); alpha is
IBM total return minus benchmark total return over the same 24-month window.

Deals whose benchmark base month predates the available benchmark data (only
ROLM 1984, before ^GSPC monthly coverage begins) keep their existing computed
entry so no benchmark comparison is lost.

Output: pipeline/data/monthly_prices.json  (drop-in for maPerformance)
"""
import json
import re
from datetime import date
from pathlib import Path
from dateutil.relativedelta import relativedelta

ROOT = Path(__file__).parent.parent
DATA_JS   = ROOT / "data.js"
DAILY_JS  = ROOT / "Story Mode" / "ibm_daily_prices.js"
BENCH     = Path(__file__).parent / "data" / "benchmark_monthly.json"
EXISTING  = Path(__file__).parent / "data" / "monthly_prices.json"
OUT       = Path(__file__).parent / "data" / "monthly_prices.json"

XLK_START = "1998-12"   # XLK monthly inception


def load_ibm_monthly():
    """Parse the daily JS array and collapse to {YYYY-MM: last-trading-day close}."""
    txt = DAILY_JS.read_text(encoding="utf-8")
    arr = re.search(r"window\.IBM_DAILY_PRICES\s*=\s*(\[.*?\]);", txt, re.DOTALL).group(1)
    daily = json.loads(arr)                       # [["YYYY-MM-DD", price], ...]
    monthly = {}
    for d, p in daily:                            # daily is chronological
        monthly[d[:7]] = p                        # later day overwrites -> month-end close
    return monthly


def parse_close(cd):
    """closeDate is 'YYYY-MM' or 'YYYY-MM-DD' -> a date anchored to that month."""
    y, m = int(cd[:4]), int(cd[5:7])
    return date(y, m, 1)


def price_at(series, target):
    """Monthly price at target month, walking back up to 2 months if missing."""
    for delta in range(0, 3):
        key = (target - relativedelta(months=delta)).strftime("%Y-%m")
        if key in series:
            return series[key], key
    return None, None


def month_series(series, start, end):
    out = []
    cur = date(start.year, start.month, 1)
    last = date(end.year, end.month, 1)
    while cur <= last:
        k = cur.strftime("%Y-%m")
        if k in series:
            out.append({"month": k, "price": series[k]})
        cur += relativedelta(months=1)
    return out


def index100(series, base):
    if not base:
        return series
    return [{"month": s["month"], "price": round(s["price"] / base * 100, 4)} for s in series]


def pct(base, end):
    return round((end - base) / base * 100, 2) if (base and end) else None


def main():
    ibm = load_ibm_monthly()
    bench_all = json.loads(BENCH.read_text(encoding="utf-8"))
    xlk, gspc = bench_all["XLK"], bench_all["^GSPC"]
    existing = {d["name"]: d for d in json.loads(EXISTING.read_text(encoding="utf-8"))["deals"]}

    src = DATA_JS.read_text(encoding="utf-8")
    m = re.search(r"window\.IBM_DATA\s*=\s*", src)
    data = json.loads(src[m.end():].rstrip().rstrip(";"))
    deals = [d for d in data["ma"]["deals"] if d.get("closeDate")]

    today = date.today()
    out_deals = []
    preserved = []
    for deal in sorted(deals, key=lambda d: d["closeDate"]):
        close = parse_close(deal["closeDate"])
        t6  = close - relativedelta(months=6)
        t18 = close + relativedelta(months=18)
        if t18 > today:
            t18 = today

        use_xlk = close.strftime("%Y-%m") >= XLK_START
        bench = xlk if use_xlk else gspc
        bench_label = "XLK" if use_xlk else "S&P 500"

        ibm_base, ibm_base_mo = price_at(ibm, t6)
        ibm_end,  ibm_end_mo  = price_at(ibm, t18)
        bch_base, _           = price_at(bench, t6)
        bch_end,  _           = price_at(bench, t18)

        # Preserve existing entry if benchmark data doesn't reach this window
        # (only the pre-1985 ROLM case) so no benchmark comparison is lost.
        if bch_base is None and deal["name"] in existing and existing[deal["name"]].get("benchReturn") is not None:
            out_deals.append(existing[deal["name"]])
            preserved.append(deal["name"])
            continue

        ibm_ret = pct(ibm_base, ibm_end)
        bch_ret = pct(bch_base, bch_end)
        alpha = round(ibm_ret - bch_ret, 2) if (ibm_ret is not None and bch_ret is not None) else None

        out_deals.append({
            "name":         deal["name"],
            "closeDate":    deal["closeDate"],
            "tMinus6":      t6.isoformat(),
            "tPlus18":      t18.isoformat(),
            "benchmark":    bench_label,
            "ibmBasePrice": ibm_base,
            "ibmBaseMonth": ibm_base_mo,
            "ibmEndPrice":  ibm_end,
            "ibmEndMonth":  ibm_end_mo,
            "ibmReturn":    ibm_ret,
            "benchReturn":  bch_ret,
            "alpha":        alpha,
            "ibmSeries":    index100(month_series(ibm,   t6, t18), ibm_base),
            "benchSeries":  index100(month_series(bench, t6, t18), bch_base),
        })

    output = {
        "generated": today.isoformat(),
        "note": ("Monthly prices: IBM from local daily adjusted close "
                 "(Story Mode/ibm_daily_prices.js), benchmark from cached "
                 "Yahoo Finance monthly (pipeline/data/benchmark_monthly.json). "
                 "IBM and benchmark indexed to 100 at T-6 months before close. "
                 "XLK from Dec 1998 onward; S&P 500 (^GSPC) for earlier deals."),
        "deals": out_deals,
    }
    OUT.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")

    n = len(out_deals)
    with_b = sum(1 for d in out_deals if d.get("benchReturn") is not None)
    with_i = sum(1 for d in out_deals if d.get("ibmReturn") is not None)
    print(f"Wrote {n} deal windows -> {OUT}")
    print(f"  with IBM return   : {with_i}")
    print(f"  with benchmark    : {with_b}")
    if preserved:
        print(f"  preserved legacy  : {preserved}")


if __name__ == "__main__":
    main()
