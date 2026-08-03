"""
inject_stock_series.py
======================
Publishes pipeline/data/stock_series.json into the site — the five series that
Section A of the Macro vs IBM tab guards on (see fetch_stock_series.py for why
they were missing and what basis they are computed on).

Same two-target contract as inject_bond_yields.py: macro.json so the series
survive the next full export_web.py run, and data.js surgically in place so
maPerformance's hand-verified figures are not regenerated away.

Re-running is safe: existing keys are replaced, not duplicated.

Run: python pipeline/inject_stock_series.py   (after fetch_stock_series.py)
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
SERIES_FILE = Path(__file__).parent / "data" / "stock_series.json"
MACRO_FILE = Path(__file__).parent / "data" / "macro.json"
DATA_JS = ROOT / "data.js"

KEYS = ["ibmTotalReturn", "sp500TotalReturn", "ibmDividendYield",
        "ibmBeta5yr", "ibmAvgDailyVolume", "stockSeriesNote"]


def js_block(key, value, base=2):
    lines = json.dumps(value, indent=1, ensure_ascii=False).split("\n")
    out = [" " * base + json.dumps(key) + ": " + lines[0]]
    out.extend(" " * base + line for line in lines[1:])
    return "\n".join(out)


def strip_existing(text, start, end, key):
    pattern = re.compile(r"\n {2}" + re.escape(json.dumps(key)) + r": (?:\{.*?\n {2}\}|\".*?\"),",
                         re.DOTALL)
    segment = text[start:end]
    cleaned, n = pattern.subn("", segment)
    return text[:start] + cleaned + text[end:], n, end - (len(segment) - len(cleaned))


def main():
    series = json.loads(SERIES_FILE.read_text(encoding="utf-8"))
    payload = {k: series[k] for k in KEYS if k != "stockSeriesNote"}
    payload["stockSeriesNote"] = series["note"]
    sources = series["sources"]

    macro = json.loads(MACRO_FILE.read_text(encoding="utf-8"))
    macro.update(payload)
    macro.setdefault("sources", {}).update(sources)
    MACRO_FILE.write_text(json.dumps(macro, indent=1) + "\n", encoding="utf-8")
    print(f"  updated {MACRO_FILE.relative_to(ROOT)}")

    text = DATA_JS.read_text(encoding="utf-8")
    macro_start = text.index('\n "macro": {')
    macro_end = text.index('\n "ma": {', macro_start)

    removed = 0
    for key in KEYS:
        text, n, macro_end = strip_existing(text, macro_start, macro_end, key)
        removed += n
    if removed:
        print(f"  replaced {removed} previously injected key(s)")

    src_anchor = text.index('\n  "sources": {', macro_start, macro_end)
    src_insert = text.index("\n", src_anchor + 1)
    src_lines = "".join(
        "\n   " + json.dumps(k) + ": " + json.dumps(v, ensure_ascii=False) + ","
        for k, v in sources.items()
        if f'\n   "{k}":' not in text[src_anchor:macro_end]
    )
    if src_lines:
        text = text[:src_insert] + src_lines + text[src_insert:]

    insert_at = text.index("\n", text.index('\n "macro": {') + 1)
    blocks = "".join("\n" + js_block(k, payload[k]) + "," for k in KEYS)
    text = text[:insert_at] + blocks + text[insert_at:]

    DATA_JS.write_text(text, encoding="utf-8")
    print(f"  updated {DATA_JS.relative_to(ROOT)}")

    raw = DATA_JS.read_text(encoding="utf-8")
    json.loads(raw[raw.index("{"):raw.rindex("}") + 1])
    print("data.js re-parsed as JSON OK")
    for k in KEYS:
        if k != "stockSeriesNote":
            ks = sorted(payload[k])
            print(f"  {k:18} {ks[0]}-{ks[-1]} (n={len(ks)})")


if __name__ == "__main__":
    main()
