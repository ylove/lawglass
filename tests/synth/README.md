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
and deletions. `makeScannedPdf()` has drawn shapes and zero text-layer items.

The congressional XML borrows only element shapes from the local reference bill;
all passages and names are invented. `INJECTION_SAMPLES` contains hostile,
bill-like strings for answer tests; `makeInjectionText(index)` wraps one in the
same bytes/ground-truth API. Tests check preservation as data, not model resistance.

Production parsers are not implemented yet. Adjacent tests round-trip basic facts
through PDF.js's legacy ESM build (Node's worker is disabled), the existing
happy-dom XML/HTML DOM readers, and test-only text section recognizers. Future
normalization tests can compare parser output directly with these expected facts.
