"""Canonical manifest of every annual-report PDF -> reporting (fiscal) year.

Resolves the awkward cases so the rest of the pipeline can key everything by a
single integer year:

  * 1912 has two files. IBM/CTR's books in this era closed at varying dates.
      - IBM_Annual-Reports_1912-03-31.pdf  -> the report dated Mar 31 1912,
        which covers fiscal year 1911.
      - IBM_Annual-Reports_1912-12-31.pdf  -> the report for FY1912.
  * 1984 has two files (1984.pdf + 1984old.pdf). 1984old is a duplicate/older
    scan; the canonical is 1984.pdf, 1984old kept as an alt for cross-check.

Each entry: year (fiscal), path (absolute), tag ("primary" | "alt"), note.
"""
import os
import re
import glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, "Intern Project- Annual Reports")

# Explicit overrides keyed by basename -> (fiscal_year, tag, note)
OVERRIDES = {
    "IBM_Annual-Reports_1912-03-31.pdf": (1911, "primary", "report dated 1912-03-31 covering FY1911"),
    "IBM_Annual-Reports_1912-12-31.pdf": (1912, "primary", "report for FY1912"),
    "IBM_Annual-Reports_1984old.pdf": (1984, "alt", "older duplicate scan of FY1984"),
    "IBM_Annual-Reports_1984.pdf": (1984, "primary", ""),
}


def _year_from_name(name):
    m = re.search(r"(19|20)\d{2}", name)
    return int(m.group(0)) if m else None


def build():
    pdfs = sorted(glob.glob(os.path.join(PDF_DIR, "**", "*.pdf"), recursive=True))
    entries = []
    for p in pdfs:
        name = os.path.basename(p)
        if name in OVERRIDES:
            year, tag, note = OVERRIDES[name]
        else:
            year = _year_from_name(name)
            tag, note = "primary", ""
        entries.append({"year": year, "path": p, "name": name, "tag": tag, "note": note})
    entries.sort(key=lambda e: (e["year"] if e["year"] else 0, e["tag"]))
    return entries


def primary_entries():
    """One canonical PDF per fiscal year (drops 'alt' duplicates)."""
    seen = {}
    for e in build():
        if e["tag"] == "primary":
            seen[e["year"]] = e
    return [seen[y] for y in sorted(seen)]


if __name__ == "__main__":
    es = build()
    print(f"{len(es)} files")
    for e in es:
        print(f"  {e['year']}  [{e['tag']}]  {e['name']}  {e['note']}")
    print(f"\n{len(primary_entries())} primary fiscal years: "
          f"{primary_entries()[0]['year']}..{primary_entries()[-1]['year']}")
