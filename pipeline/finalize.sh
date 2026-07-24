#!/usr/bin/env bash
# Wait for mechanical extraction to finish (all 116 md files) then run the full
# auto-fill chain and final validation. Bounded so it can't hang forever.
set -e
cd "$(dirname "$0")"
PY=../.venv/Scripts/python.exe
MD=raw/pymupdf4llm

deadline=$(( $(date +%s) + 2700 ))   # 45 min safety bound
while :; do
  n=$(ls "$MD" | wc -l)
  echo "waiting: $n/116 md files ($(date +%H:%M:%S))"
  [ "$n" -ge 116 ] && { echo "extraction complete"; break; }
  [ "$(date +%s)" -ge "$deadline" ] && { echo "TIMEOUT at $n/116 -- proceeding with what exists"; break; }
  sleep 30
done

echo "=== harvest ===";     "$PY" harvest.py     2>&1 | tail -1
echo "=== reconcile ===";   "$PY" reconcile.py   2>&1 | tail -1
echo "=== build_modern ==="; "$PY" build_modern.py 2>&1 | tail -1
echo "=== assemble ===";    "$PY" assemble.py    2>&1 | tail -1
echo "=== validate ===";    "$PY" validate.py    2>&1
echo "FINALIZE DONE"
