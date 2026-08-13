"""
inject_ma_clean.py
==================
Replaces the "ma" block in data.js with the cleaned 78-deal dataset
from pipeline/data/ma_clean.json.
"""
import json, re
from pathlib import Path

ROOT        = Path(__file__).parent.parent
CLEAN_FILE  = Path(__file__).parent / "data" / "ma_clean.json"
DATA_JS     = ROOT / "data.js"

clean = json.loads(CLEAN_FILE.read_text(encoding="utf-8"))

# Build the new "ma" block as it should appear in data.js
# We indent with 1 space (matching the existing file style)
def js_val(v):
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return json.dumps(v, ensure_ascii=False)

lines = [' "ma": {']
lines.append('  "_comment": "IBM M&A history — auto-extracted from annual report filings and cleaned. '
             f'{len(clean["deals"])} unique deals. All values in US$ millions.",')
lines.append('  "summary": ' + json.dumps(clean["summary"], ensure_ascii=False) + ',')
lines.append('  "deals": [')

for i, d in enumerate(clean["deals"]):
    comma = "," if i < len(clean["deals"]) - 1 else ""
    lines.append("   {")
    for key, val in d.items():
        lines.append(f"    {json.dumps(key)}: {js_val(val)},")
    # remove trailing comma on last field
    lines[-1] = lines[-1].rstrip(",")
    lines.append("   }" + comma)

lines.append("  ]")
# NOTE: the closing brace is appended later, once we know whether the block we
# are replacing was followed by a comma (i.e. more keys follow it in data.js).

# Read data.js and locate the ma block
src = DATA_JS.read_text(encoding="utf-8")

# Find the ma block using a regex that matches from "ma": { to the matching close
# We'll use line-based approach for reliability
src_lines = src.splitlines(keepends=True)

ma_start_line = None
ma_end_line   = None

for i, line in enumerate(src_lines):
    if '"ma": {' in line and ma_start_line is None:
        ma_start_line = i

if ma_start_line is None:
    print("ERROR: could not find ma block start")
    exit(1)

# Walk forward from the block start and brace-match to find its close.
# This used to be gated on first finding an "annualSummary" key inside the
# block, but the block written below has no such key -- so once this script
# had run once, every later run failed with "could not find ma block end".
depth = 0
for j in range(ma_start_line, len(src_lines)):
    for ch in src_lines[j]:
        if ch == '{': depth += 1
        if ch == '}': depth -= 1
    if depth == 0 and j > ma_start_line:
        ma_end_line = j
        break

if ma_end_line is None:
    print("ERROR: could not find ma block end")
    exit(1)

# Close the block with the same punctuation the original had: "}," when more
# keys follow it in data.js (maPerformance does), plain "}" when it is last.
# Emitting a bare "}" unconditionally produced invalid JS on the next key.
lines.append(" }," if src_lines[ma_end_line].rstrip().endswith(",") else " }")
new_block = "\n".join(lines)

print(f"Replacing lines {ma_start_line+1}–{ma_end_line+1} in data.js")
print(f"Old block: {ma_end_line - ma_start_line + 1} lines")
print(f"New block: {len(new_block.splitlines())} lines")

new_src = (
    "".join(src_lines[:ma_start_line])
    + new_block + "\n"
    + "".join(src_lines[ma_end_line + 1:])
)

DATA_JS.write_text(new_src, encoding="utf-8")
print(f"data.js updated successfully.")
