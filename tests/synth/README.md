# Synthetic legislation samples

Import generators from `tests/synth/index.js`. They return `{ bytes, groundTruth }`
in memory and write no files. PDF generators are async; all others are synchronous.
Each call returns fresh bytes and ground truth. PDF metadata uses a fixed date so
identical options produce identical bytes and document hashes.

Ground truth includes a section tree using the frozen model contracts, plus
`deletedStrings` and `insertedStrings`. Non-PDF samples have no printed citation
coordinates. Amending PDFs additionally expose per-page `lines` (line number to
body text), header/footer text, layout coordinates, expected top-level section
numbers, and amendment decoration geometry. Coordinates are PDF points with the
origin at the bottom left. `makeAmendingBillPdf({ pageCount: 3 })` adds a third
page; the default is two. Both drawn lines and filled rectangles mark insertions
and deletions. `makeScannedPdf()` has a page image, drawn shapes and zero text-layer items.

`makeAmendmentGeometryPdf()` holds one line per amendment-geometry case, on two
pages whose line numbers restart: strikes and underlines as lines and thin
rects, at Word's strikeout height and at Ohio's underline depths; marks inside
one merged text run, down to a single struck comma or inserted letter; an
underline that runs on over a trailing space; insertions and deletions that wrap
across a line and across the page break; and struck headings and markers. Its
`controls` are negative controls the parser must ignore: a table rule between
lines, a full-width rule through text, a table-cell box, a signature line, a
line through whitespace only, near misses beside and below text, and a bar too
thick to be a typographic rule.

`makeScannedRedlinePdf()` (`scanned-pdf.ts`) mimics an Acrobat "Paper Capture"
scan for the raster strike/underline detector (#193): a page image with strikes
and underlines in the pixels only, under an invisible (render mode 3) OCR text
layer with one text item per OCR word. Words are rasterized with a built-in 5x7
bitmap font (`scanned-font.ts`, no canvas). Page text uses a tiny markup:
`[-struck-]`, `{+inserted+}`, and `[-old-]{+new+}` for one OCR word spanning both.
Options: `dpi`, `skewDegrees` (rotates the raster only, so OCR boxes drift from the
ink), `noise`, `encoding` (`flate` or `jpeg`, via `jpeg-js`), `strips`, `noImage`,
`markThicknessPx`, `seed`. The result is `{ bytes, truth }`; `truth` lists each
word's status, OCR box, baseline, x-height and exact mark geometry in PDF points
before skew (`inkPositionAfterSkew` maps a point to where the skewed ink lands).
`SCANNED_PRESETS` / `makeScannedPreset(name)` hold the required cases: clean,
merged, tricky-negatives (e crossbars, hyphens, dashes), short-words, skewed (2
degrees), low-dpi (90), strips and no-image. The generator is deterministic.
Note: pdfjs merges neighbouring same-size text chunks, so each OCR word alternates
its font size by 0.001pt to stay a separate text item.

The congressional XML borrows only element shapes from the local reference bill;
all passages and names are invented. `INJECTION_SAMPLES` contains hostile,
bill-like strings for answer tests; `makeInjectionText(index)` wraps one in the
same bytes/ground-truth API. Tests check preservation as data, not model resistance.

`makeBillStatusXml()` returns fresh XML bytes for the history adapter, rather
than a legislation section tree. Its small, hand-written BILLSTATUS record has
invented sponsors, cosponsors, actions, amendments, text versions, and CRS
summaries. No downloaded government records are included.

Adjacent tests round-trip basic facts through PDF.js's legacy ESM build (Node's
worker is disabled), the existing happy-dom XML/HTML DOM readers, and test-only
text section recognizers. The PDF parser's tests (`src/core/parse/pdf.test.ts`)
compare its output directly with these expected facts.
