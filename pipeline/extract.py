"""Mechanical extraction layer: every PDF -> markdown + per-page text + tables.

Runs the two parsers that work on Python 3.14:
  * pymupdf4llm  -> structured Markdown (good for narrative + reading order)
  * pdfplumber   -> tables (CSV/JSON) + raw text (good for financial tables)

Outputs (one set per file; '_alt' suffix for duplicate scans):
  pipeline/raw/pymupdf4llm/<year>.md
  pipeline/raw/text/<year>.txt              (pymupdf plain text, page-delimited)
  pipeline/raw/pdfplumber/<year>.tables.json (list of {page, table_index, rows})
  pipeline/raw/pdfplumber/<year>.txt         (pdfplumber text, page-delimited)

Idempotent: skips a file if all its outputs already exist (use --force to redo).
Writes pipeline/raw/_manifest.tsv summarising what was produced.
"""
import os
import sys
import json
import time
import traceback

import fitz
import pymupdf4llm
import pdfplumber

from manifest import build as build_manifest, ROOT

RAW = os.path.join(ROOT, "pipeline", "raw")
DIRS = {
    "md": os.path.join(RAW, "pymupdf4llm"),
    "text": os.path.join(RAW, "text"),
    "plumb": os.path.join(RAW, "pdfplumber"),
}
for d in DIRS.values():
    os.makedirs(d, exist_ok=True)

FORCE = "--force" in sys.argv
ONLY = None
for a in sys.argv[1:]:
    if a.startswith("--year="):
        ONLY = int(a.split("=")[1])


def key_for(entry):
    return f"{entry['year']}{'_alt' if entry['tag'] == 'alt' else ''}"


def outputs_for(key):
    return {
        "md": os.path.join(DIRS["md"], f"{key}.md"),
        "text": os.path.join(DIRS["text"], f"{key}.txt"),
        "tables": os.path.join(DIRS["plumb"], f"{key}.tables.json"),
        "plumbtext": os.path.join(DIRS["plumb"], f"{key}.txt"),
    }


def extract_one(entry):
    key = key_for(entry)
    out = outputs_for(key)
    path = entry["path"]
    if not FORCE and all(os.path.exists(p) for p in out.values()):
        return key, "skip", 0, 0

    # 1) pymupdf4llm markdown
    md = pymupdf4llm.to_markdown(path, show_progress=False)
    with open(out["md"], "w", encoding="utf-8") as f:
        f.write(md)

    # 2) pymupdf plain text, page-delimited
    doc = fitz.open(path)
    parts = []
    for i in range(doc.page_count):
        parts.append(f"\n\n===== PAGE {i + 1} =====\n" + doc[i].get_text("text"))
    doc.close()
    with open(out["text"], "w", encoding="utf-8") as f:
        f.write("".join(parts))

    # 3) pdfplumber tables + text
    tables = []
    ptext = []
    n_tables = 0
    with pdfplumber.open(path) as pdf:
        for pi, page in enumerate(pdf.pages, start=1):
            ptext.append(f"\n\n===== PAGE {pi} =====\n" + (page.extract_text() or ""))
            for ti, tbl in enumerate(page.extract_tables() or []):
                if not tbl:
                    continue
                n_tables += 1
                tables.append({"page": pi, "table_index": ti, "rows": tbl})
    with open(out["tables"], "w", encoding="utf-8") as f:
        json.dump(tables, f, ensure_ascii=False, indent=1)
    with open(out["plumbtext"], "w", encoding="utf-8") as f:
        f.write("".join(ptext))

    return key, "ok", len(md), n_tables


def main():
    entries = build_manifest()
    if ONLY is not None:
        entries = [e for e in entries if e["year"] == ONLY]
    log = []
    t0 = time.time()
    for i, e in enumerate(entries, 1):
        key = key_for(e)
        try:
            k, status, mdlen, ntab = extract_one(e)
            dt = time.time() - t0
            print(f"[{i:>3}/{len(entries)}] {k:<10} {status:<4} md={mdlen:>7} tables={ntab:>4}  ({dt:.0f}s)", flush=True)
            log.append((k, e["year"], e["tag"], status, mdlen, ntab, e["name"]))
        except Exception as ex:
            print(f"[{i:>3}/{len(entries)}] {key:<10} ERROR {ex}", flush=True)
            traceback.print_exc()
            log.append((key, e["year"], e["tag"], "ERROR", 0, 0, e["name"]))

    with open(os.path.join(RAW, "_manifest.tsv"), "w", encoding="utf-8") as f:
        f.write("key\tyear\ttag\tstatus\tmd_chars\tn_tables\tname\n")
        for r in log:
            f.write("\t".join(str(x) for x in r) + "\n")
    print(f"\nDone {len(log)} files in {time.time() - t0:.0f}s -> {RAW}")


if __name__ == "__main__":
    main()
