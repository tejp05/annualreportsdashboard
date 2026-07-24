"""Probe every annual-report PDF: page count, embedded-text density, file size.

This tells us which reports have a usable text layer (modern filings) vs. which
are scanned images that need OCR (old CTR/IBM reports). Writes pipeline/data/probe.tsv.
"""
import os
import re
import glob
import fitz  # pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF_DIR = os.path.join(ROOT, "Intern Project- Annual Reports")
OUT = os.path.join(ROOT, "pipeline", "data", "probe.tsv")


def year_from_name(path):
    name = os.path.basename(path)
    # Prefer a 19xx/20xx anywhere in the name
    m = re.search(r"(19|20)\d{2}", name)
    return m.group(0) if m else "?"


def main():
    pdfs = sorted(glob.glob(os.path.join(PDF_DIR, "**", "*.pdf"), recursive=True))
    rows = []
    for p in pdfs:
        try:
            doc = fitz.open(p)
            n = doc.page_count
            chars = 0
            sample_pages = min(n, 8)
            for i in range(sample_pages):
                chars += len(doc[i].get_text("text"))
            doc.close()
            chars_per_page = chars / sample_pages if sample_pages else 0
        except Exception as e:
            n, chars_per_page = -1, -1
            print("ERR", p, e)
        size_mb = os.path.getsize(p) / 1e6
        rel = os.path.relpath(p, PDF_DIR)
        rows.append((year_from_name(p), n, round(chars_per_page), round(size_mb, 1),
                     "SCANNED" if 0 <= chars_per_page < 200 else "TEXT", rel))

    rows.sort(key=lambda r: (r[0], r[5]))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write("year\tpages\tchars/pg\tMB\tlayer\trelpath\n")
        for r in rows:
            f.write("\t".join(str(x) for x in r) + "\n")

    scanned = sum(1 for r in rows if r[4] == "SCANNED")
    print(f"{len(rows)} PDFs | {scanned} likely SCANNED (need OCR) | {len(rows)-scanned} have text layer")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
