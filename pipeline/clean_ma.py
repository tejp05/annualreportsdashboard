"""
clean_ma.py
===========
Reads pipeline/data/ma_full.json (raw extraction) and produces
pipeline/data/ma_clean.json — a deduplicated, junk-filtered list
of every IBM acquisition and divestiture found in the annual reports.

Rules applied:
  1. Remove junk names  — names that start with lowercase, contain
     sentence fragments, or match a blocklist of known false positives.
  2. Deduplicate        — same company name across multiple report years
     collapses to a single record using the EARLIEST close year and the
     BEST available value figure.
  3. Normalise names    — strip trailing legal suffixes where a cleaner
     short name already exists (e.g. "Kenexa Corporation" -> "Kenexa").
  4. Merge with ma.json — patch in the hand-verified values from the
     existing curated file where available.
"""

import json
import re
from pathlib import Path

RAW_FILE     = Path(__file__).parent / "data" / "ma_full.json"
CURATED_FILE = Path(__file__).parent / "data" / "ma.json"
OUT_FILE     = Path(__file__).parent / "data" / "ma_clean.json"

# ---------------------------------------------------------------------------
# Junk / false-positive blocklist
# Names that matched the regex but are clearly not company names
# ---------------------------------------------------------------------------
JUNK_NAMES = {
    # Sentence fragments
    "if fair value cannot be reasonably netezza corpo",
    "on january 9, 2012, the company announced it had",
    "in addition, at september 30, 2014, the company",
    "in april 2015, the fasb issued guidance about wh",
    "the following table reflects the purchase price",
    "for the other acquisitions, the overall weighted",
    "sopra group. through the spss acquisition in 200",
    "revenue by classes of similar products or",
    "technology segment, and the associated maintenan",
    "ibm and lenovo entered into a strategic relation",
    "synnex would retail stores",
    # Generic / non-company words
    "others",
    "healthcare",
    "global",
    "select ibm",
    "select ibm software products",
    "microelectronics",
    "industry standard server",
    "customer care",
    # Segment names mistaken for companies
    "technology",
    "global business services",
    "global technology services",
    "systems and technology",
    "these changes",
    "inc.",
    "ltd.",
    "group, llc",
    # Cross-references
    "automated security assurance cloud & cognitive",
    "instana cloud & cognitive",
    "aac acquisition.",
    # Duplicate fragment variants
    "ecx copy data management business from",
    "vevre software business from volta, inc.",
    "storwize, a provider of in-line data compression",
    "seterus",          # mortgage servicer, not an IBM acquisition
    # Remaining junk from review pass
    "sopra group. through the spss acquisition in 200",
    "sopra group.",
    "ibm and lenovo entered into a strategic relation",
    "for the other acquisitions, the overall weighted",
    "storwize, a provider of in-line data compress",
    "storwize, a provider of in-line data compression",
    "if fair value cannot be reasonably netezza",
    "if fair value cannot be reasonably netezza corpo",
    "on january 9, 2012, the company announced it had",
    "netezza",           # duplicate of "netezza corporation" which is the cleaner name
    "spss",              # duplicate — curated entry "spss inc." is the canonical one
}

# Regex patterns — names matching these are also junk
JUNK_PATTERNS = [
    re.compile(r"^[a-z]"),                          # starts lowercase
    re.compile(r"\b(fasb|gaap|ifrs|aoci|oci)\b", re.I),  # accounting terms
    re.compile(r"^\s*(the\s+following|in\s+addition|under\s+the)", re.I),
    re.compile(r"^\d"),                              # starts with digit
    re.compile(r"\.{3,}"),                           # ellipsis / truncated
    re.compile(r"\b(segment|quarter|percent|million|billion|revenue|liability|goodwill)\b", re.I),
]

# Other-deal ticker false positives
JUNK_TICKERS = {"GTS", "GBS", "STG", "STG)"}


def is_junk(name: str) -> bool:
    n = name.strip().lower()
    # Exact match
    if n in JUNK_NAMES:
        return True
    # Prefix / substring match for blocklist entries (catches truncated variants)
    for junk in JUNK_NAMES:
        if len(junk) >= 15 and n.startswith(junk[:15]):
            return True
    if len(n) < 3:
        return True
    for pat in JUNK_PATTERNS:
        if pat.search(name):
            return True
    return False


# ---------------------------------------------------------------------------
# Name normalisation — strip legal suffixes for cleaner display
# ---------------------------------------------------------------------------
LEGAL_SUFFIX_RE = re.compile(
    r",?\s+(Inc\.|Corp\.|Corporation|LLC|Ltd\.|Limited|GmbH|"
    r"Pty Ltd|S\.A\.|SAS|AB|AG|PLC|N\.V\.|B\.V\.)\.?$",
    re.IGNORECASE,
)


def normalise_name(name: str) -> str:
    """Strip trailing ', Inc.' etc. but only if result is still >= 3 chars."""
    clean = LEGAL_SUFFIX_RE.sub("", name).strip()
    return clean if len(clean) >= 3 else name


# ---------------------------------------------------------------------------
# Determine the true close year for a deal
# 2021/2022/2023 tabular entries are re-listed each year — use the EARLIEST
# ---------------------------------------------------------------------------
def best_close_year(records: list[dict]) -> int:
    years = [r.get("closeYear") or r.get("reportYear") for r in records]
    return min(y for y in years if y)


def best_value(records: list[dict]) -> float | None:
    vals = [r["valueMillions"] for r in records if r.get("valueMillions")]
    return min(vals) if vals else None   # smallest = most likely the actual deal value


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    raw    = json.loads(RAW_FILE.read_text(encoding="utf-8"))
    curated_deals = json.loads(CURATED_FILE.read_text(encoding="utf-8"))["deals"]

    # Build a lookup of curated deals keyed by normalised name
    curated_map: dict[str, dict] = {}
    for d in curated_deals:
        key = normalise_name(d["name"]).lower()
        curated_map[key] = d

    # ── Combine named_deals + other_deals ────────────────────────────────────
    all_raw: list[dict] = raw["named_deals"] + raw["other_deals"]

    # Group by normalised name (case-insensitive)
    grouped: dict[str, list[dict]] = {}
    for record in all_raw:
        name = record["name"].strip()
        if is_junk(name):
            continue
        # For other_deals, also check ticker
        if record.get("ticker") in JUNK_TICKERS:
            continue

        norm = normalise_name(name).lower()
        grouped.setdefault(norm, []).append(record)

    # ── Build clean records ───────────────────────────────────────────────────
    clean_deals: list[dict] = []

    for norm_key, records in grouped.items():
        # Use the canonical name from the FIRST (earliest report year) record
        records_sorted = sorted(records, key=lambda r: r.get("reportYear", 9999))
        canonical_name = normalise_name(records_sorted[0]["name"])

        close_year  = best_close_year(records)
        value       = best_value(records)
        deal_type   = records_sorted[0].get("type", "acquisition")
        segment     = next((r.get("segment") for r in records if r.get("segment")), None)
        ticker      = next((r.get("ticker") for r in records if r.get("ticker") and r.get("ticker") not in JUNK_TICKERS), None)

        # Pull the extracted close date straight from the filing text, preferring
        # a record whose closeYear matches the chosen close_year (guards against
        # a stale re-mention in a later year's report disagreeing on the date)
        dated_records = [r for r in records if r.get("closeDate") and r.get("closeYear") == close_year]
        if not dated_records:
            dated_records = [r for r in records if r.get("closeDate")]
        extracted_close_date = dated_records[0]["closeDate"] if dated_records else None

        # Patch from curated data if available
        curated = curated_map.get(norm_key) or curated_map.get(canonical_name.lower())
        if curated:
            value       = curated.get("valueMillions") or value
            deal_type   = curated.get("type", deal_type)
            description = curated.get("description")
            category    = curated.get("category")
            tier        = curated.get("tier", "minor")
            close_date  = curated.get("closeDate") or extracted_close_date
            ibm_lang    = curated.get("ibmLanguage")
        else:
            description = None
            category    = segment   # use segment as rough category proxy
            tier        = "major" if (value and value >= 500) else "minor"
            close_date  = extracted_close_date
            ibm_lang    = None

        clean_deals.append({
            "year":          close_year,
            "name":          canonical_name,
            "type":          deal_type,
            "valueMillions": value,
            "tier":          tier,
            "category":      category,
            "segment":       segment,
            "closeDate":     close_date,
            "description":   description,
            "ibmLanguage":   ibm_lang,
            "source":        "filing-extracted",
        })

    # Sort by year, then name
    clean_deals.sort(key=lambda d: (d["year"], d["name"]))

    # ── Add curated deals not already captured ────────────────────────────────
    # Also: if curated name is a longer variant of an auto-extracted name,
    # patch the value in rather than adding a duplicate entry.
    def first_word(s):
        return re.split(r"[\s,\(]", normalise_name(s))[0].lower()

    first_word_map = {first_word(d["name"]): i for i, d in enumerate(clean_deals)}
    existing_names = {normalise_name(d["name"]).lower() for d in clean_deals}
    added = 0
    for cd in curated_deals:
        norm = normalise_name(cd["name"]).lower()
        fw   = first_word(cd["name"])
        # If a clean deal already has the same first word, just patch the value
        if norm not in existing_names and fw in first_word_map:
            idx = first_word_map[fw]
            if not clean_deals[idx]["valueMillions"] and cd.get("valueMillions"):
                clean_deals[idx]["valueMillions"] = cd["valueMillions"]
                clean_deals[idx]["description"]   = clean_deals[idx]["description"] or cd.get("description")
                clean_deals[idx]["closeDate"]      = clean_deals[idx]["closeDate"] or cd.get("closeDate")
            continue
        if norm not in existing_names:
            clean_deals.append({
                "year":          cd["year"],
                "name":          cd["name"],
                "type":          cd["type"],
                "valueMillions": cd.get("valueMillions"),
                "tier":          cd.get("tier", "major"),
                "category":      cd.get("category"),
                "segment":       cd.get("segment"),
                "closeDate":     cd.get("closeDate"),
                "description":   cd.get("description"),
                "ibmLanguage":   cd.get("ibmLanguage"),
                "source":        "curated",
                # Deals flagged maTabOnly render on the M&A tab (counts, spend,
                # era cards, timeline) but are excluded from the Macro tab's
                # stock-chart acquisition markers -- see app.js majorDeals filter.
                "maTabOnly":     cd.get("maTabOnly", False),
            })
            added += 1

    clean_deals.sort(key=lambda d: (d["year"], d["name"]))

    # ── Stats ─────────────────────────────────────────────────────────────────
    total         = len(clean_deals)
    with_value    = sum(1 for d in clean_deals if d["valueMillions"])
    acquisitions  = sum(1 for d in clean_deals if d["type"] == "acquisition")
    divestitures  = sum(1 for d in clean_deals if d["type"] in ("divestiture", "spinoff"))

    print(f"\nClean deals total  : {total}")
    print(f"  Acquisitions     : {acquisitions}")
    print(f"  Divestitures     : {divestitures}")
    print(f"  With $ value     : {with_value}")
    print(f"  Added from curated (not auto-found): {added}")

    print(f"\nDeals by year:")
    from collections import Counter
    yc = Counter(d["year"] for d in clean_deals)
    for y in sorted(yc):
        print(f"  {y}: {yc[y]}")

    # ── Write output ──────────────────────────────────────────────────────────
    output = {
        "_comment": (
            "Cleaned & deduplicated IBM M&A history. "
            "Source: auto-extracted from pipeline/raw/pdfplumber/ + hand-curated ma.json. "
            "All dollar values in US$ millions."
        ),
        "summary": {
            "total":        total,
            "acquisitions": acquisitions,
            "divestitures": divestitures,
            "withValue":    with_value,
        },
        "deals": clean_deals,
    }

    OUT_FILE.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nOutput written to: {OUT_FILE}")


if __name__ == "__main__":
    main()
