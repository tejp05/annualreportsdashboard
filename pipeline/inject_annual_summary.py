"""
inject_annual_summary.py
========================
Adds a deduplicated annualCounts block into the ma section of data.js,
derived from the IBM-stated acquisition counts in ma_full.json.
"""
import json, re
from pathlib import Path

ROOT       = Path(__file__).parent.parent
FULL_FILE  = Path(__file__).parent / "data" / "ma_full.json"
DATA_JS    = ROOT / "data.js"

full = json.loads(FULL_FILE.read_text(encoding="utf-8"))

# Deduplicate: for each deal year, keep the entry with highest count
raw = []
for yr, block in full["by_year"].items():
    for s in block.get("annualSummaries", []):
        raw.append(s)

best = {}
for s in raw:
    y = s["year"]
    if y not in best or s["count"] > best[y]["count"]:
        best[y] = s

# Build the annualCounts object sorted by year
annual_counts = {str(y): {"count": v["count"], "totalMillions": v["totalMillions"]}
                 for y, v in sorted(best.items())}

# Read data.js and find the end of the deals array inside ma block
src = DATA_JS.read_text(encoding="utf-8")

# We'll insert annualCounts just before the closing } of the ma block
# The ma block ends with:  ]\n },\n "maPerformance"
insert_marker = '  ]\n },\n "maPerformance"'
replacement   = (
    '  ],\n'
    '  "annualCounts": ' + json.dumps(annual_counts, indent=2)
        .replace('\n', '\n  ') + '\n'
    ' },\n "maPerformance"'
)

if insert_marker not in src:
    print("ERROR: marker not found — check data.js structure")
    exit(1)

new_src = src.replace(insert_marker, replacement, 1)
DATA_JS.write_text(new_src, encoding="utf-8")
print(f"Injected annualCounts for {len(annual_counts)} years into data.js")
print("Years:", sorted(annual_counts.keys()))
