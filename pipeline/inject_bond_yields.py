"""
inject_bond_yields.py
=====================
Publishes pipeline/data/ibm_bond_yields.json into the site, for the
"IBM's Cost of Debt vs the Risk-Free Curve" card on the Macro vs IBM tab.

Writes to BOTH places on purpose:

  1. pipeline/data/macro.json -- so the series survives the next full
     `python pipeline/export_web.py` run, which rebuilds data.js from the
     pipeline JSONs and would otherwise drop anything only ever patched
     into data.js.

  2. data.js -- surgically, in place. We do NOT regenerate data.js here:
     maPerformance carries hand-verified per-deal benchmark figures (see
     fetch_sp500tr_benchmark.py) that a blind regeneration would discard.

Re-running is safe: existing keys are replaced, not duplicated.

Run: python pipeline/inject_bond_yields.py   (after fetch_ibm_bond_yields.py)
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).parent.parent
BONDS_FILE = Path(__file__).parent / "data" / "ibm_bond_yields.json"
MACRO_FILE = Path(__file__).parent / "data" / "macro.json"
DATA_JS = ROOT / "data.js"

# macro.<key> written into the site, in the order they should appear
KEYS = [
    "ibmCostOfDebt",
    "ibmCostOfDebtCashCheck",
    "ibmInterestIncurredM",
    "ibmAvgTotalDebtM",
    "treasuryCurve",
    "treasuryTenorLabels",
    "bondYieldNote",
]

SOURCE_ENTRIES = {
    "ibmCostOfDebt": ("SEC EDGAR XBRL us-gaap:InterestCostsIncurred (IBM total interest cost, "
                      "including financing-segment interest charged to cost of financing) divided "
                      "by average total debt from the 10-K balance sheets. Realised book rate "
                      "across the whole debt stack, NOT a market yield on IBM bonds"),
    "ibmCostOfDebtCashCheck": ("SEC EDGAR XBRL us-gaap:InterestPaidNet over the same average debt "
                               "-- independent cash cross-check on ibmCostOfDebt"),
    "treasuryCurve": ("Yahoo Finance ^IRX / ^FVX / ^TNX / ^TYX (13-week bill, 5-yr, 10-yr, 30-yr), "
                      "annual mean of monthly closes. Note this is an annual AVERAGE, unlike "
                      "treasury10yr above, which is a Jan-1 point reading from multpl.com"),
}


def as_macro_payload(bonds):
    """Map the fetch script's output onto the macro.* keys the site reads."""
    return {
        "ibmCostOfDebt": bonds["ibmCostOfDebt"],
        "ibmCostOfDebtCashCheck": bonds["ibmCostOfDebtCashCheck"],
        "ibmInterestIncurredM": bonds["ibmInterestIncurredM"],
        "ibmAvgTotalDebtM": bonds["ibmAvgTotalDebtM"],
        "treasuryCurve": bonds["treasury"],
        "treasuryTenorLabels": bonds["tenorLabels"],
        "bondYieldNote": bonds["note"],
    }


def update_macro_json(payload):
    macro = json.loads(MACRO_FILE.read_text(encoding="utf-8"))
    macro.update(payload)
    macro.setdefault("sources", {}).update(SOURCE_ENTRIES)
    MACRO_FILE.write_text(json.dumps(macro, indent=1) + "\n", encoding="utf-8")
    print(f"  updated {MACRO_FILE.relative_to(ROOT)}")


def js_block(key, value, base=2):
    """Render one key as data.js formats it: 2-space key, 1-space nesting."""
    lines = json.dumps(value, indent=1, ensure_ascii=False).split("\n")
    out = [" " * base + json.dumps(key) + ": " + lines[0]]
    out.extend(" " * base + line for line in lines[1:])
    return "\n".join(out)


def strip_existing(text, start, end, key):
    """Remove a previously injected `key` block from data.js[start:end]."""
    pattern = re.compile(r"\n {2}" + re.escape(json.dumps(key)) + r": (?:\{.*?\n {2}\}|\".*?\"),",
                         re.DOTALL)
    segment = text[start:end]
    cleaned, n = pattern.subn("", segment)
    return text[:start] + cleaned + text[end:], n, end - (len(segment) - len(cleaned))


def update_data_js(payload):
    text = DATA_JS.read_text(encoding="utf-8")

    macro_start = text.index('\n "macro": {')
    macro_end = text.index('\n "ma": {', macro_start)

    # drop any prior injection so re-runs stay idempotent
    removed = 0
    for key in KEYS:
        text, n, macro_end = strip_existing(text, macro_start, macro_end, key)
        removed += n
    if removed:
        print(f"  replaced {removed} previously injected key(s)")

    # add source provenance next to the other macro series descriptions
    src_anchor = text.index('\n  "sources": {', macro_start, macro_end)
    src_insert = text.index("\n", src_anchor + 1)
    src_lines = "".join(
        "\n   " + json.dumps(k) + ": " + json.dumps(v, ensure_ascii=False) + ","
        for k, v in SOURCE_ENTRIES.items()
        if f'\n   "{k}":' not in text[src_anchor:macro_end]
    )
    if src_lines:
        text = text[:src_insert] + src_lines + text[src_insert:]
        macro_end += len(src_lines)

    # insert the series themselves at the top of the macro block
    insert_at = text.index("\n", text.index('\n "macro": {') + 1)
    blocks = "".join("\n" + js_block(k, payload[k]) + "," for k in KEYS)
    text = text[:insert_at] + blocks + text[insert_at:]

    DATA_JS.write_text(text, encoding="utf-8")
    print(f"  updated {DATA_JS.relative_to(ROOT)}")


def main():
    bonds = json.loads(BONDS_FILE.read_text(encoding="utf-8"))
    payload = as_macro_payload(bonds)

    print("Injecting IBM bond-yield series ...")
    update_macro_json(payload)
    update_data_js(payload)

    years = sorted(payload["ibmCostOfDebt"])
    print(f"\nibmCostOfDebt  {years[0]}-{years[-1]} ({len(years)} years)")
    print(f"treasuryCurve  tenors: {', '.join(payload['treasuryCurve'])}")

    # fail loudly rather than shipping a data.js the browser cannot parse
    raw = DATA_JS.read_text(encoding="utf-8")
    body = raw[raw.index("{"):raw.rindex("}") + 1]
    json.loads(body)
    print("data.js re-parsed as JSON OK")


if __name__ == "__main__":
    main()
