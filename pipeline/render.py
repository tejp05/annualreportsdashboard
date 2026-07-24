"""Render report pages to PNG for visual verification (the 'parse it myself'
fallback for garbled-OCR early reports and the scanned 2002 filing).

Usage:  python render.py <year> <page-or-range> [dpi]
  e.g.  python render.py 1915 3-7
        python render.py 2002 5
Writes pipeline/data/_review/<year>_p<NN>.png and prints the paths.
"""
import os
import sys

import fitz
from manifest import ROOT, build as build_manifest

REVIEW = os.path.join(ROOT, "pipeline", "data", "_review")
os.makedirs(REVIEW, exist_ok=True)


def path_for_year(year):
    for e in build_manifest():
        if e["year"] == year and e["tag"] == "primary":
            return e["path"]
    raise SystemExit(f"no primary report for {year}")


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    year = int(sys.argv[1])
    rng = sys.argv[2]
    dpi = int(sys.argv[3]) if len(sys.argv) > 3 else 200
    if "-" in rng:
        a, b = rng.split("-")
        pages = range(int(a), int(b) + 1)
    else:
        pages = [int(rng)]
    doc = fitz.open(path_for_year(year))
    mat = fitz.Matrix(dpi / 72, dpi / 72)
    for p in pages:
        if 1 <= p <= doc.page_count:
            pix = doc[p - 1].get_pixmap(matrix=mat)
            out = os.path.join(REVIEW, f"{year}_p{p:02d}.png")
            pix.save(out)
            print(out)
    doc.close()


if __name__ == "__main__":
    main()
