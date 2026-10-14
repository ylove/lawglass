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
