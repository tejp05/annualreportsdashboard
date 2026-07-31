"""
patch_pre1999_benchmarks.py
=============================
One-off surgical patch: rewrite the benchmark/benchReturn/alpha/benchSeries
fields for the 5 maPerformance.deals entries whose 2-year window predates
XLK (Dec 1998) and was therefore benchmarked against price-only ^GSPC while
IBM's own return includes reinvested dividends -- an apples-to-oranges
comparison that flattered IBM's alpha. Replaced with the total-return
S&P 500 series built by fetch_sp500tr_benchmark.py.

This does NOT touch anything else in data.js -- it finds each object by its
exact name+closeDate, brace-matches to find that single object's boundaries,
and replaces only that JSON object's text in place. Every other byte of the
file (financials, segments, macro, other M&A deals, etc.) is untouched.

Run once: python pipeline/patch_pre1999_benchmarks.py
"""
import json
import re
from datetime import date
from pathlib import Path
from dateutil.relativedelta import relativedelta

ROOT = Path(__file__).parent.parent
DATA_JS = ROOT / "data.js"
SP500TR_MONTHLY = json.load(open(ROOT / "pipeline" / "data" / "ma_sp500tr_monthly.json", encoding="utf-8"))["series"]

# (name, closeDate, ibmReturn [unchanged], new benchmark label)
TARGETS = [
    ("ROLM Corporation",               "1984-11", 51.21,   "S&P 500 (TR, reconstructed pre-1988)"),
    ("ROLM Systems → Siemens",     "1989-09", 14.12,   "S&P 500 (TR)"),
    ("Information Products → Lexmark", "1991-03", -16.45, "S&P 500 (TR)"),
    ("Lotus Development Corporation",  "1995-07-05", 122.39, "S&P 500 (TR)"),
    ("Tivoli Systems, Inc.",           "1996-03-04", 129.06, "S&P 500 (TR)"),
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


def find_object_span(text, name, close_date):
    """Locate `{ "name": "<name>", "closeDate": "<close_date>", ... }` and
    return (start, end) character offsets of the full object, via brace
    matching from the opening `{`."""
    anchor = f'"name": "{name}",\n    "closeDate": "{close_date}",'
    idx = text.find(anchor)
    if idx == -1:
        raise ValueError(f"anchor not found for {name!r} / {close_date!r}")
    # walk back to the nearest unmatched "{" before idx
    brace_start = text.rfind("{", 0, idx)
    # brace-match forward from brace_start
    depth = 0
    in_str = False
    escape = False
    i = brace_start
    while i < len(text):
        c = text[i]
        if in_str:
            if escape:
                escape = False
            elif c == "\\":
                escape = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return brace_start, i + 1
        i += 1
    raise ValueError(f"unbalanced braces for {name!r}")


def reindent(json_text, base_spaces):
    prefix = " " * base_spaces
    return "\n".join(prefix + line if line else line for line in json_text.split("\n"))


def main():
    text = DATA_JS.read_text(encoding="utf-8")

    for name, close_date, ibm_ret, bench_label in TARGETS:
        start, end = find_object_span(text, name, close_date)
        obj_text = text[start:end]
        obj = json.loads(obj_text)
        assert obj["name"] == name and obj["closeDate"] == close_date

        close = parse_close(close_date)
        t6 = close - relativedelta(months=6)
        t18 = close + relativedelta(months=18)
        base, _ = price_at(SP500TR_MONTHLY, t6)
        end_p, _ = price_at(SP500TR_MONTHLY, t18)
        bench_ret = pct(base, end_p)
        alpha = round(ibm_ret - bench_ret, 2)
        series = index100(month_series(SP500TR_MONTHLY, t6, t18), base)

        obj["benchmark"] = bench_label
        obj["benchReturn"] = bench_ret
        obj["alpha"] = alpha
        obj["benchSeries"] = series

        new_obj_text = reindent(json.dumps(obj, indent=1, ensure_ascii=False), 3)
        text = text[:start] + new_obj_text + text[end:]
        # re-find subsequent anchors against the *updated* text next loop iteration
        print(f"patched {name} ({close_date}): benchReturn={bench_ret}  alpha={alpha}  benchmark={bench_label}")

    DATA_JS.write_text(text, encoding="utf-8")
    print(f"\nwrote {DATA_JS}")


if __name__ == "__main__":
    main()
