"""
recompute_pre1999_deals.py
============================
One-off: recompute the 3 deals whose benchmark was wrong (^GSPC price-only vs
IBM's dividend-adjusted return) using the new total-return series built by
fetch_sp500tr_benchmark.py. Prints the corrected fields (does NOT write
data.js directly -- those 3 entries were hand-verified and hand-patched into
data.js, same as the rest of maPerformance.deals).

Method matches pipeline/build_ma_performance.py exactly: index to 100 at T-6,
total return = (end/base - 1), alpha = IBM return - benchmark return.
"""
import json
from datetime import date
from pathlib import Path
from dateutil.relativedelta import relativedelta

ROOT = Path(__file__).parent.parent
monthly = json.load(open(ROOT / "pipeline" / "data" / "ma_sp500tr_monthly.json", encoding="utf-8"))["series"]

DEALS = [
    ("ROLM Corporation", "1984-11", 51.21),
    ("Lotus Development Corporation", "1995-07-05", 122.39),
    ("Tivoli Systems, Inc.", "1996-03-04", 129.06),
]


def parse_close(cd):
    y, m = int(cd[:4]), int(cd[5:7])
    return date(y, m, 1)


def price_at(series, target):
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
    return [{"month": s["month"], "price": round(s["price"] / base * 100, 4)} for s in series]


def pct(base, end):
    return round((end - base) / base * 100, 2)


for name, cd, ibm_ret in DEALS:
    close = parse_close(cd)
    t6 = close - relativedelta(months=6)
    t18 = close + relativedelta(months=18)
    base, base_mo = price_at(monthly, t6)
    end, end_mo = price_at(monthly, t18)
    bench_ret = pct(base, end)
    alpha = round(ibm_ret - bench_ret, 2)
    series = index100(month_series(monthly, t6, t18), base)

    print(f"=== {name} ===")
    print(f"  ibmReturn (unchanged): {ibm_ret}")
    print(f"  benchReturn (new, S&P 500 TR): {bench_ret}")
    print(f"  alpha (new): {alpha}")
    print(f"  benchSeries: {json.dumps(series)}")
    print()
