# Era logos

The homepage shows IBM's logo evolution and ties it to the timeline slider.
These are clean **SVG renditions** of each era's mark:

| File | Era | Mark |
|------|-----|------|
| `era-ctr.svg`   | 1911–1923 | Computing-Tabulating-Recording Co. monogram |
| `era-globe.svg` | 1924–1946 | "International Business Machines" globe |
| `era-solid.svg` | 1947–1971 | Solid slab-serif **IBM** (Beton Bold) |
| `era-8bar.svg`  | 1972–today | Paul Rand 8-bar **IBM** |

## Swapping in the original scans

To use the exact historical logo images instead of these SVG renditions,
just drop a replacement file with the **same base name** in this folder
(e.g. `era-ctr.png`) and update the `file` path in the `LOGOS` array in
`../../app.js`. Keep them roughly 200×80 with transparent or white backgrounds
so they sit cleanly in the logo strip.
