"""
extract_ma.py
=============
Scans all parsed annual-report text files in pipeline/raw/pdfplumber/
and extracts every named acquisition and divestiture from the
"Acquisitions/Divestitures" notes section.

Two formats are handled:
  - Pre-2019 : two-column PDF, interleaved lines, named deals use "—On Month DD, YYYY"
  - 2019+    : single-column PDF, tabular list of company names per quarter

Output:  pipeline/data/ma_full.json
"""

import json
import re
from pathlib import Path

RAW_DIR  = Path(__file__).parent / "raw" / "pdfplumber"
OUT_FILE = Path(__file__).parent / "data" / "ma_full.json"

# ---------------------------------------------------------------------------
# Patterns
# ---------------------------------------------------------------------------

# Note heading (many variants across 115 years of reports)
# Also matches mid-line occurrences in two-column interleaved PDFs
NOTE_START_RE = re.compile(
    r"NOTE\s+[A-Z]\.\s+ACQUISITIONS[/&\s]|"   # NOTE C. ACQUISITIONS/… or NOTE C. ACQUISITIONS &…
    r"NOTE\s+[A-Z]\.\s+ACQUIS|"
    r"ACQUISITIONS/DIVESTITURES\s*$|"          # at end of line (interleaved)
    r"ACQUISITIONS/DIVESTITURES\s*\n|"         # on its own line
    r"ACquISITIOnS/DIvESTITuRES",              # mixed-case OCR artefact
    re.IGNORECASE | re.MULTILINE,
)

# End of the acquisitions note — next major NOTE heading
NOTE_END_RE = re.compile(
    r"^NOTE\s+[A-Z]\.\s+(?!ACQUI)",
    re.IGNORECASE | re.MULTILINE,
)

# Annual summary: "In 20XX, the company completed N acquisitions at an aggregate cost of $X million"
ANNUAL_SUMMARY_RE = re.compile(
    r"In (\d{4}),\s+the company completed\s+(\w+)\s+acquisitions?"
    r"(?:\s+at an aggregate cost of \$([\d,]+(?:\.\d+)?)\s*(million|billion))?",
    re.IGNORECASE,
)

# Pre-2019 named deal: "Company Name (Ticker)—On Month DD, YYYY"
# These appear in two-column interleaved text so we search within scraped lines
NAMED_DEAL_OLD_RE = re.compile(
    r"([A-Z][A-Za-z0-9 ,\.&'\-/]+?)"         # Company name
    r"(?:\s*\(([A-Za-z0-9 &,\.\-/]+?)\))?"   # optional (ticker/abbrev)
    r"\s*[—\u2014\-]{1,2}\s*"                 # dash separator
    r"On\s+(\w+)\.?\s+(\d{1,2}),?\s*(\d{4})",    # On Month DD, YYYY
    re.MULTILINE,
)

MONTH_TO_NUM = {
    "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
    "july": 7, "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "jun": 6, "jul": 7, "aug": 8,
    "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}

# Dollar value anywhere near a deal description
VALUE_RE = re.compile(
    r"\$\s*([\d,]+(?:\.\d+)?)\s*(million|billion)",
    re.IGNORECASE,
)

# Word-to-number for "eight", "ten", etc. in summary lines
WORD_TO_NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14,
    "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20,
}

# 2019+ tabular format: "CompanyName Segment Description of Acquired Business"
# Single space between name, segment, and description
TABLE_NAME_RE = re.compile(
    r"^([A-Z][A-Za-z0-9][A-Za-z0-9 ,\.&'\-/\.]{1,50}?)\s+"
    r"(Software|Consulting|Infrastructure|Technology|Services|Systems)\s+"
    r"[A-Z].{5,}",
    re.MULTILINE,
)

# Quarter markers in the tabular format
QUARTER_RE = re.compile(r"^(First|Second|Third|Fourth)\s+Quarter$", re.IGNORECASE | re.MULTILINE)

# Divestiture lines
DIVEST_RE = re.compile(
    r"(?:divest(?:ed|iture)|sold|separated?|spin(?:ned|s)?[\s-]off?|separation of)\s+"
    r"(?:its\s+)?(?:the\s+)?([A-Z][A-Za-z0-9 ,\.&'\-/]{2,60})",
    re.IGNORECASE,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def word_or_digit_to_int(s: str) -> int | None:
    s = s.strip().lower()
    if s.isdigit():
        return int(s)
    return WORD_TO_NUM.get(s)


def parse_value(val_str: str, unit: str) -> float | None:
    try:
        v = float(val_str.replace(",", ""))
        return round(v * 1000 if unit.lower() == "billion" else v, 1)
    except (ValueError, AttributeError):
        return None


# The acquisitions note heading can appear in many places:
#   - Table of contents  (~5-10% through)
#   - MD&A cross-reference   (~10-30%)
#   - Cash flow statement    (~45-55%)    ← "net of acquisitions/divestitures"
#   - ACTUAL NOTE            (~55-80%)   ← what we want
#
# Strategy: find ALL matches, filter out false positives by context,
# and use the LAST match that is followed by acquisition content.

NOTE_CONTEXT_RE = re.compile(
    r"(Acquisitions|acquired|acquisition|completed|consideration)",
    re.IGNORECASE,
)

def find_note_block(text: str) -> str:
    """Find the acquisitions note block by taking the LAST heading match
    that is followed within 300 chars by acquisition-related content."""
    all_matches = list(NOTE_START_RE.finditer(text))
    if not all_matches:
        return ""

    # Walk matches in reverse; stop at the first one that has acq content nearby
    for m in reversed(all_matches):
        snippet = text[m.end(): m.end() + 500]
        if NOTE_CONTEXT_RE.search(snippet):
            remainder = text[m.start():]
            m_end = NOTE_END_RE.search(remainder[50:])
            if m_end:
                return remainder[: m_end.start() + 50]
            return remainder[:10000]

    return ""


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------

def parse_annual_summaries(block: str) -> list[dict]:
    results = []
    for m in ANNUAL_SUMMARY_RE.finditer(block):
        year  = int(m.group(1))
        count = word_or_digit_to_int(m.group(2))
        val   = parse_value(m.group(3), m.group(4)) if m.group(3) else None
        if count:
            results.append({"year": year, "count": count, "totalMillions": val})
    return results


def parse_named_deals_old(block: str, report_year: int) -> list[dict]:
    """Pre-2019 format: 'Company (Ticker)—On Month DD, YYYY … $X million'"""
    deals = []
    for m in NAMED_DEAL_OLD_RE.finditer(block):
        name       = m.group(1).strip()
        ticker     = m.group(2).strip() if m.group(2) else None
        month_word = m.group(3)
        day        = int(m.group(4))
        close_year = int(m.group(5))

        month_num = MONTH_TO_NUM.get(month_word.lower())
        close_date = f"{close_year:04d}-{month_num:02d}-{day:02d}" if month_num else None

        # Look ahead ~500 chars for a dollar value
        chunk = block[m.end(): m.end() + 500]
        vm    = VALUE_RE.search(chunk)
        value = parse_value(vm.group(1), vm.group(2)) if vm else None

        deals.append({
            "reportYear":    report_year,
            "closeYear":     close_year,
            "closeDate":     close_date,
            "name":          name,
            "ticker":        ticker,
            "valueMillions": value,
            "type":          "acquisition",
            "source":        "named-deal",
        })
    return deals


YEAR_HEADER_RE    = re.compile(r"^(19|20)\d{2}\s*$", re.MULTILINE)
QUARTER_HEADER_RE = re.compile(r"^(First|Second|Third|Fourth)\s+Quarter\s*$", re.MULTILINE)
QUARTER_MID_MONTH = {"First": 2, "Second": 5, "Third": 8, "Fourth": 11}   # midpoint month of each fiscal quarter


def parse_table_deals_new(block: str, report_year: int) -> list[dict]:
    """2019+ tabular format: 'Company Segment Description' rows grouped under
    'YYYY' year headers and 'First/Second/.../Quarter' sub-headers. A single
    note often repeats 1-2 prior years for comparison, so we track the
    year/quarter headers as we scan rather than trusting the outer report_year
    for every row -- otherwise a comparative prior-year deal gets mislabeled
    with the current filing's year."""
    deals = []

    # Tag every character offset with the year/quarter header active at that point
    markers = []   # (offset, kind, value)
    for m in YEAR_HEADER_RE.finditer(block):
        markers.append((m.start(), "year", int(m.group(0))))
    for m in QUARTER_HEADER_RE.finditer(block):
        markers.append((m.start(), "quarter", m.group(1)))
    markers.sort(key=lambda t: t[0])

    def active_at(offset):
        year, quarter = report_year, None
        for off, kind, val in markers:
            if off > offset:
                break
            if kind == "year":
                year, quarter = val, None   # a new year header resets the quarter
            else:
                quarter = val
        return year, quarter

    for m in TABLE_NAME_RE.finditer(block):
        name    = m.group(1).strip()
        segment = m.group(2).strip()
        # Skip obvious boilerplate / header rows
        if name.lower() in ("acquisition", "company", "segment", "description"):
            continue
        close_year, quarter = active_at(m.start())
        close_date = None
        if quarter:
            close_date = f"{close_year:04d}-{QUARTER_MID_MONTH[quarter]:02d}-15"
        deals.append({
            "reportYear":     report_year,
            "closeYear":      close_year,
            "closeQuarter":   quarter,
            "closeDate":      close_date,
            "closeDateExact": False,
            "name":           name,
            "ticker":         None,
            "segment":        segment,
            "valueMillions":  None,
            "type":           "acquisition",
            "source":         "table",
        })
    return deals


def parse_divestitures(block: str, report_year: int) -> list[dict]:
    deals = []
    seen  = set()
    for m in DIVEST_RE.finditer(block):
        name = m.group(1).strip().rstrip(",.")
        if len(name) < 4 or name.lower() in seen:
            continue
        seen.add(name.lower())
        deals.append({
            "reportYear":    report_year,
            "closeYear":     report_year,
            "name":          name,
            "ticker":        None,
            "valueMillions": None,
            "type":          "divestiture",
            "source":        "divest-mention",
        })
    return deals


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    all_by_year   = {}
    flat_named    = []
    flat_table    = []
    seen_named    = set()   # (closeYear, normalised name)
    seen_table    = set()   # (reportYear, normalised name)

    txt_files = sorted(RAW_DIR.glob("*.txt"))
    print(f"Scanning {len(txt_files)} text files...\n")

    for txt_path in sorted(txt_files):
        stem = txt_path.stem
        if not re.fullmatch(r"\d{4}", stem):
            continue

        report_year = int(stem)
        text        = txt_path.read_text(encoding="utf-8", errors="replace")
        block       = find_note_block(text)

        if not block.strip():
            continue

        summaries = parse_annual_summaries(block)

        # Choose parser based on era (tabular format appears from ~2019)
        if report_year >= 2019:
            named  = parse_table_deals_new(block, report_year)
        else:
            named  = parse_named_deals_old(block, report_year)

        divest = parse_divestitures(block, report_year)

        has_data = summaries or named or divest
        if not has_data:
            continue

        all_by_year[stem] = {
            "annualSummaries": summaries,
            "namedDeals":      named,
            "divestitures":    divest,
        }

        print(
            f"  {report_year}: "
            f"{len(summaries)} summary, "
            f"{len(named)} named deals, "
            f"{len(divest)} divestiture mention(s)"
        )

        # De-duplicate into flat lists
        for deal in named:
            key = (deal["closeYear"], re.sub(r"\s+", " ", deal["name"].lower()))
            if key not in seen_named:
                seen_named.add(key)
                flat_named.append(deal)

    # ------------------------------------------------------------------
    # Also collect company names from "Other Acquisitions" paragraphs
    # (pre-2019 reports list them inline in prose)
    # ------------------------------------------------------------------
    OTHER_CO_RE = re.compile(
        r"(?:acquisition of\s+)?([A-Z][A-Za-z0-9][A-Za-z0-9 ,\.&'\-/]{2,50}?)"
        r"\s*\(([A-Z][A-Za-z0-9 &,\.\-/]{1,30})\)",
    )
    OTHER_BLOCK_RE = re.compile(
        r"Other [Aa]cquisitions[—\-\s]+([\s\S]{100,1500})(?=\n\n|\Z)",
    )

    flat_other = []
    seen_other = set()

    for txt_path in sorted(txt_files):
        stem = txt_path.stem
        if not re.fullmatch(r"\d{4}", stem):
            continue
        report_year = int(stem)
        text        = txt_path.read_text(encoding="utf-8", errors="replace")
        block       = find_note_block(text)
        if not block:
            continue

        for block_m in OTHER_BLOCK_RE.finditer(block):
            prose = block_m.group(1)
            for co_m in OTHER_CO_RE.finditer(prose):
                full  = co_m.group(1).strip()
                short = co_m.group(2).strip()
                # Skip generic phrases
                if any(w in full.lower() for w in ["percent", "million", "billion", "quarter", "segment"]):
                    continue
                key = (report_year, re.sub(r"\s+", " ", full.lower()))
                if key not in seen_other:
                    seen_other.add(key)
                    flat_other.append({
                        "reportYear": report_year,
                        "name":       full,
                        "ticker":     short,
                        "type":       "acquisition",
                        "source":     "other-acq-prose",
                    })

    # ------------------------------------------------------------------
    # Totals
    # ------------------------------------------------------------------
    total_named = len(flat_named)
    total_other = len(flat_other)
    total_all   = total_named + total_other

    print(f"\n{'-'*55}")
    print(f"Named major deals extracted  : {total_named}")
    print(f"Smaller deals from prose     : {total_other}")
    print(f"TOTAL unique deal names found: {total_all}")
    print(f"{'-'*55}\n")

    output = {
        "_comment": (
            "Auto-extracted from pipeline/raw/pdfplumber/ text files. "
            "'named_deals' = individually disclosed deals (with date or value). "
            "'other_deals' = company names from 'Other Acquisitions' paragraphs. "
            "All dollar values in US$ millions."
        ),
        "summary": {
            "namedDeals": total_named,
            "otherDeals": total_other,
            "totalDeals": total_all,
        },
        "named_deals": sorted(flat_named, key=lambda d: (d["closeYear"], d["name"])),
        "other_deals":  sorted(flat_other, key=lambda d: (d["reportYear"], d["name"])),
        "by_year":      all_by_year,
    }

    OUT_FILE.write_text(json.dumps(output, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Output written to: {OUT_FILE}")


if __name__ == "__main__":
    main()
