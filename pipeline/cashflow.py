"""Extract operating cash flow, capital expenditure, and free cash flow from
the already-parsed IBM annual report markdown files in pipeline/raw/pymupdf4llm/.

WARNING (2026-07-02): data/cashflow.json contains manually-curated 1995-2002 rows
(statement-verified OCF/capex/FCF) that this script does NOT reproduce -- a blind
re-run replaces them with bad pattern matches (e.g. 2000 OCF "92000"). If you must
re-run, diff against git and restore the curated rows.

IBM has reported formal cash flow statements since ~1988 (FASB Statement 95).
This script covers ~1995-2025; pre-1995 reports are too format-variable to
cover in a single pass and are left null.

Strategy (tried in order per year, first match wins):
  1. Financial Highlights table row  (clean, ~2002-2020)
  2. Three-year summary OCF table    (~1995-2001)
  3. Prose dollar-figure extraction  (CEO/MD&A narrative)
  4. Full Consolidated Cash Flow Statement rows (deepest fallback)

Output: pipeline/data/cashflow.json
  {
    "1997": {
      "operatingCashFlow": 8865,
      "capitalExpenditure": 6900,
      "freeCashFlow": null,
      "ocfSource": "summary-table",
      "capexSource": "prose",
      "fcfSource": null
    }, ...
  }

All values in US$ millions (same as financials.json).
Run: python pipeline/cashflow.py
"""
import os, re, json, glob
from manifest import ROOT

RAW_MD = os.path.join(ROOT, "pipeline", "raw", "pymupdf4llm")
DATA    = os.path.join(ROOT, "pipeline", "data")


# ── helpers ──────────────────────────────────────────────────────────────────

def read(year):
    path = os.path.join(RAW_MD, f"{year}.md")
    if os.path.exists(path):
        return open(path, encoding="utf-8", errors="replace").read()
    return None


def to_millions(s):
    """Convert a dollar string like '$16,724' or '16.3 billion' to US$ millions."""
    s = s.strip().replace("$", "").replace(",", "").replace(" ", "")
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    # if very small (< 200) assume billions, convert to millions
    if abs(v) < 200:
        v = round(v * 1000, 0)
    return int(round(v))


def first_match(text, patterns):
    """Return (value_in_millions, pattern_name) for the first pattern that matches."""
    for name, pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            raw = m.group(1).strip().lstrip("$").replace(",", "")
            v = to_millions(raw)
            if v and v > 100:   # sanity: OCF/capex > $100M for IBM
                return v, name
    return None, None


# ── per-metric pattern lists ──────────────────────────────────────────────────

# Operating cash flow patterns (ordered: most-reliable first)
OCF_PATTERNS = [
    # Financial Highlights table row (2002-2020 era)
    ("highlights-table",
     r"Net cash\s*(?:provided by|from)\s*operating activities(?:\s*from continuing operations)?"
     r"[\s|$\\*]*\$?\s*([\d,]+)"),
    # Three-year summary table compact cell (1997-2001 era)
    ("summary-table-compact",
     r"Operating activities\s*\**\s*\$?\s*\**\s*([\d,]+)"),
    # Prose: "net cash from/provided by operating activities was $X billion"
    ("prose-billions",
     r"net cash (?:from|provided by) operating activities[^.]*?(?:was|of)\s*\$\s*([\d.]+)\s*billion"),
    # Prose: "generated \$X billion in cash from operations"
    ("prose-ops-billions",
     r"generated\s*\$\s*([\d.]+)\s*billion in cash (?:from|provided by) operations"),
    # Full statement row
    ("statement-row",
     r"Net cash provided by operating activities\D{0,30}?\$?\s*([\d,]+)"),
]

CAPEX_PATTERNS = [
    # Financial Highlights table row
    ("highlights-table",
     r"Capital expenditures,?\s*net[\s|$\\*]*\$?\s*\*?\s*([\d,]+)"),
    # Selected data / highlights table variant
    ("highlights-table-v2",
     r"(?:Net )?[Cc]apital expenditures[\s|$\\*]*\$?\s*\*?\s*([\d,]+)"),
    # Investment in plant etc (older label)
    ("plant-label",
     r"Investment in plant[^|]*(?:continuing operations)?[\s|$\\*]*\$?\s*([\d,]+)"),
    # Prose: "X billion in net capital expenditures"
    ("prose-billions",
     r"\$([\d.]+)\s*billion in net capital expenditures"),
    ("prose-billions-v2",
     r"\$([\d.]+)\s*billion (?:on|in) capital expenditures"),
    # Full statement
    ("statement-row",
     r"Purchases? of property[^$\n]{0,60}\$?\s*([\d,]+)"),
]

FCF_PATTERNS = [
    # Explicit "free cash flow was $X" or "free cash flow of $X"
    ("explicit-billions",
     r"free cash flow[^.]{0,60}(?:was|of|generated)\s*\$?\s*([\d.]+)\s*billion"),
    ("explicit-billions-v2",
     r"generated[^.]{0,40}\$?\s*([\d.]+)\s*billion (?:of )?(?:in )?free cash flow"),
    # Table: "Free cash flow | $X"
    ("table-row",
     r"Free cash flow[\s|$\\*]{1,20}\$?\s*\*?\s*([\d,]+)"),
    # Prose with millions
    ("explicit-millions",
     r"free cash flow[^.]{0,60}(?:was|of)\s*\$\s*([\d,]+)\s*million"),
]


# ── prior-year cross-check from multi-column tables ──────────────────────────

def extract_prior_years_ocf(text, current_year):
    """Try to pull prior-year OCF values from three-year summary tables.
    Returns dict of {year: millions}."""
    found = {}
    # Pattern: three values in a row after 'Operating activities' header
    m = re.search(
        r"Operating activities\b[^|]*\|?\s*\$?\s*\*?\s*([\d,]+)"
        r"[^|]*\|?\s*\$?\s*\*?\s*([\d,]+)"
        r"[^|]*\|?\s*\$?\s*\*?\s*([\d,]+)",
        text, re.IGNORECASE)
    if m:
        for i, raw in enumerate(m.groups()):
            v = to_millions(raw.replace(",",""))
            if v and v > 100:
                found[current_year - i] = v
    return found


# ── main extraction loop ──────────────────────────────────────────────────────

def extract_year(year):
    text = read(year)
    if not text:
        return None

    ocf,  ocf_src  = first_match(text, OCF_PATTERNS)
    cap,  cap_src  = first_match(text, CAPEX_PATTERNS)
    fcf,  fcf_src  = first_match(text, FCF_PATTERNS)

    # derive FCF if not stated but both components found
    if fcf is None and ocf is not None and cap is not None:
        fcf = ocf - cap
        fcf_src = "derived(ocf-capex)"

    return {
        "operatingCashFlow": ocf,
        "capitalExpenditure": cap,
        "freeCashFlow": fcf,
        "ocfSource": ocf_src,
        "capexSource": cap_src,
        "fcfSource": fcf_src,
    }


def main():
    results = {}
    prior_ocf = {}   # cross-fills from multi-year summary tables

    for year in range(1995, 2026):
        row = extract_year(year)
        if row is None:
            continue
        results[str(year)] = row

        # try to collect prior-year OCF cross-checks
        text = read(year)
        if text:
            extras = extract_prior_years_ocf(text, year)
            for y, v in extras.items():
                if str(y) not in prior_ocf:
                    prior_ocf[str(y)] = []
                prior_ocf[str(y)].append(v)

    # fill missing OCF from cross-year picks (e.g. 1995/1996 from 1997 table)
    for y_str, vals in prior_ocf.items():
        if y_str in results and results[y_str]["operatingCashFlow"] is not None:
            continue
        if int(y_str) < 1995:
            continue
        # take the most common value if multiple; else median-ish
        consensus = max(set(vals), key=vals.count)
        if y_str not in results:
            results[y_str] = {
                "operatingCashFlow": consensus,
                "capitalExpenditure": None,
                "freeCashFlow": None,
                "ocfSource": "cross-year-table",
                "capexSource": None,
                "fcfSource": None,
            }
        elif results[y_str]["operatingCashFlow"] is None:
            results[y_str]["operatingCashFlow"] = consensus
            results[y_str]["ocfSource"] = "cross-year-table"

    # ── IBM-stated overrides ─────────────────────────────────────────────
    # IBM's official FCF definition excludes the year-to-year change in Global
    # Financing receivables; naive OCF-capex derivation can miss it by $B's
    # (2009: derived 17,026 vs IBM-stated 15,100). Wherever IBM states FCF,
    # that figure wins. 2003-2007 from the 2007 report five-year road-map
    # table; 2008-2010 from MD&A prose; 2019-2020 from MD&A tables (all
    # mirrored in anchors.json). 2005/2006 OCF from the consolidated cash
    # flow statements (continuing operations).
    STATED_FCF = {"2003": 8700, "2004": 9100, "2005": 9600, "2006": 10500,
                  "2007": 12400, "2008": 14300, "2009": 15100, "2010": 16300,
                  "2019": 11909, "2020": 10805}
    STATED_OCF = {"2005": 14914, "2006": 15019}
    blank = {"operatingCashFlow": None, "capitalExpenditure": None,
             "freeCashFlow": None, "ocfSource": None, "capexSource": None,
             "fcfSource": None}
    for y_str, v in STATED_FCF.items():
        r = results.setdefault(y_str, dict(blank))
        r["freeCashFlow"] = v
        r["fcfSource"] = "md&a-stated-override"
    for y_str, v in STATED_OCF.items():
        r = results.setdefault(y_str, dict(blank))
        r["operatingCashFlow"] = v
        r["ocfSource"] = "cashflow-stmt-override"

    out = {
        "_comment": (
            "Extracted from IBM annual report text (pipeline/raw/pymupdf4llm/). "
            "All values US$ millions. freeCashFlow is IBM's own stated figure where "
            "available, otherwise derived as operatingCashFlow - capitalExpenditure. "
            "IBM sometimes defines FCF excluding Global Financing receivables; that "
            "definition is used when it appears in the CEO/MD&A narrative (noted in source). "
            "Coverage: ~1995-2025. Re-run: python pipeline/cashflow.py"
        ),
        "years": dict(sorted(results.items())),
    }

    path = os.path.join(DATA, "cashflow.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2)

    # print summary
    ok_ocf  = sum(1 for v in results.values() if v["operatingCashFlow"]  is not None)
    ok_cap  = sum(1 for v in results.values() if v["capitalExpenditure"] is not None)
    ok_fcf  = sum(1 for v in results.values() if v["freeCashFlow"]       is not None)
    print(f"Years processed:       {len(results)}")
    print(f"operatingCashFlow:     {ok_ocf} years")
    print(f"capitalExpenditure:    {ok_cap} years")
    print(f"freeCashFlow:          {ok_fcf} years")
    print(f"-> {path}")
    print()
    # spot-check a few known values
    checks = {"2010": ("operatingCashFlow", 19000), "2018": ("operatingCashFlow", 15247),
              "2002": ("operatingCashFlow", 13788), "2017": ("capitalExpenditure", 3312)}
    print("Spot-checks:")
    for y, (k, expected) in checks.items():
        got = results.get(y, {}).get(k)
        ok = "✓" if got and abs(got - expected) / expected < 0.05 else "✗"
        print(f"  {y} {k}: got={got}  expected≈{expected}  {ok}")


if __name__ == "__main__":
    main()
