# 0010: Recovering scanned redlines by pixel analysis

**Status:** accepted (2026-10-14), issues #192, #193

## Context

[ADR 0006](0006-pdf-amendment-geometry.md) reads strike-through and underline from vector paths in a PDF's content stream. A scanned document has no such paths. The marks are dark pixels in a page image. Many city charter amendments and ballot issues exist only as scans, so without a second method the parser would read repealed text as current law, the failure this tool exists to prevent.

OCR'd scans come in two forms, and both pass as ordinary text PDFs today:

- **Searchable image.** The page is the scan, with an OCR text layer drawn in invisible text (render mode 3) on top.
- **ClearScan.** Adobe Paper Capture replaces the scan with visible OCR text, drawn over a washed-out copy of the page as a background image, and turns some long rules into vector paths. Franklin County's ballot Issue 8 (a Columbus City Charter amendment, #191) is this kind. Its underlines mostly became vector paths, which ADR 0006 already reads. Its strike-throughs survive only as short dark dashes in the background image, in the gaps between glyphs, because ClearScan erased the line wherever it crossed a letter. Two of its nine struck words left no trace at all.

In both forms PDF.js returns the OCR text, so `SCANNED_PDF` (which fires only when no page has 50 characters) does not fire. The OCR text holds the words but not the marks, and it often glues a struck word to the inserted word after it (`city` + `by` read as one word). Scan skew adds a third problem: on Issue 8 the text is rotated 0.5 to 0.7 degrees, and the parser drops rotated text as a stamp, which silently deleted a whole section (#192).

## Decision

**Use deterministic pixel analysis, not a vision model.** The user chose this on 2026-10-14. The reasons:

- **Repeatable.** The same scan gives the same marks every time. A vision model can vary between runs and cannot be tested to a recall and precision number the same way.
- **Local.** The page image never leaves the machine. A vision model would send legislation scans to a provider, which breaks the localhost-first posture and costs money on every page.
- **Checkable.** A pixel rule is a measurement that a person can inspect and a test can pin down. A model's reason for calling a word struck is not.

**Detect OCR scans first** (#192). A page is an OCR scan when either holds:

- its text is almost all drawn in invisible render modes (3 or 7), at least 90% of its glyphs, tracked through save and restore, whether or not a readable image operator is present, because PDF.js drops images over its size limit. A footer, Bates number or "RECEIVED" stamp added in visible text afterward does not hide the scan. Any render-mode-3 text over an image that covers 85% or more of the page also counts (mode 7 does not: layout tools use it to fill a title with an image), whatever the producer, because scanner firmware does not name an OCR tool; or
- visible text is drawn over an image that covers the page, and the producer names an OCR tool such as Paper Capture (the ClearScan form). The producer is read from the Info dictionary and the XMP packet, and "OCR" must start a word, so "Democracy Suite" and "Socrata" do not match.

Text rotated by up to 2 degrees is scan skew, not a stamp: it is read as horizontal text in the line's own frame instead of being dropped. `SCANNED_PDF` keeps its rule on all characters, since counting only visible ones would refuse every OCR'd scan. Every document with an OCR-scan page gets a warning that the text comes from OCR and may contain errors. Until the raster step ships, the warning says marks were not read.

**Read the marks from pixels** (#193). The pure functions over pixel buffers live in `src/core/parse/pdf-raster.ts`, so they unit-test without PDF.js.

1. Await each decoded page image (asynchronously, with a timeout and the abort signal) before the page is cleaned up. Handle the grayscale 1-bit, RGB and RGBA image kinds. Cap decoded pixels per page and per document.
2. Map each OCR word box to pixels through the inverse image transform. The transform must be axis-aligned, or the page abstains. Work per word box, not per line, because a one-degree skew drifts about 15 pixels across a line. Binarize locally with Otsu's method.
3. A **strike** is dark ink on the x-height row that crosses at least one blank column between glyphs, so the crossbar of an "e" and hyphens do not count. In a ClearScan background the strike survives only in those gaps, so a row-aligned series of short dashes across a run of words counts as one strike. For one- and two-letter words, the run must extend past the glyph ink. An **underline** is a run in the band just below the baseline. Measure the core thickness and clamp it to the same maximum that the vector rules use, so a strike on a 144-dpi JPEG does not land in "too thick".
4. **Use the OCR junctions.** When one OCR word straddles the start or end of an underline, the part outside the underline is a likely struck word glued to the inserted one. It is marked struck as _uncertain_.
5. **Synthesize `MarkSegment`s in user space and append them to the page's vector segments.** From there, `classifyMarkHeight`, `glyphExtents`, `markLine` and the whitespace rules in `pdf-geometry.ts` run unchanged. That includes splitting an OCR-merged word where a strike stops partway through it. One pipeline decides what is struck, whichever way the evidence arrived.

**Abstain and warn.** A page abstains, with a "marks not read on page N" warning and no segments, when any of these holds:

- skew is greater than 1.5 degrees;
- resolution is under 100 dpi;
- binarization is weakly bimodal (no clear ink and paper levels);
- OCR boxes do not line up with the ink.

For a word that is uncertain, **apply the strike and do not apply the underline**, and warn with the lines involved. This follows ADR 0006: calling repealed text current is the worse error, while a missed underline only leaves new text looking like current text, and the warning tells the reader to check. The contract-change issue (#199) adds a per-page scan status (`read`, `uncertain` or `not-read`) so the UI and the "What changes" chip can say the truth. On a scan whose marks were not read, that chip must not answer "no changes".

**Release gate: precision first.** Without raster marks, every struck word in a scan reads as current text (with a warning). Raster marks can only shrink that, unless they mark current law as struck, which is a new harm. So raster marks ship on only if, on the labeled real scans plus the synthetic suite, **struck-word precision is at least 0.95 and inserted-word precision at least 0.90**. Recall is measured and reported, never hidden: on Issue 8, pixels alone can reach at most about 0.78 of struck words, because two left no trace. Any holdout is reported separately. Results go in `eval/results-scanned.md`. If the gate fails, raster marks ship off, and scanned documents warn that struck words may appear as current text. The warning stays on every scanned document either way, because recall below 1 is expected.

**Ship three PDF.js WASM files.** Scans use JBIG2, CCITT and JPEG 2000 codecs that PDF.js decodes with WebAssembly. We ship `jbig2.wasm`, `openjpeg.wasm` and `qcms_bg.wasm`, with their licenses, in `dist/pdfjs-wasm/`. `wasmUrl` is set to a filesystem path ending in `/`, because Node's binary data factory reads it with `fs.readFile`. In development it resolves `node_modules/pdfjs-dist/wasm/`. We never ship the `*_nowasm_fallback.js` files or `quickjs-eval`: they run generated or eval'd code, and the WASM path does not need them. The packed tarball is tested to contain only the allowed WASM files.

**This amends ADR 0006.** That ADR says the parser needs no files from the PDF.js package at run time, and the CLI inlines PDF.js. That stays true for vector PDFs. Three WASM binaries are now the one exception, and only because decoding a scan needs them.

## Failure modes this guards against

- **Repealed text read as current law.** The warning, the uncertain-strike rule and the "not read" status stop a silent miss.
- **Plain text read as struck.** Crossbars, hyphens, skew and noisy scans produce false strikes. The blank-column rule, per-word boxes, abstention and the precision gate stop this.
- **A confident answer on an unread scan.** The scan status keeps the "What changes" chip from saying "no changes" when no marks were read.
- **Executable fallbacks in the package.** Excluding the no-WASM fallbacks and `quickjs-eval` keeps eval'd code out of the tarball.

## Consequences

- Scanned documents are sometimes only partly read. A warning on every such page is the intended behavior, not a defect.
- Raster marks may ship off for rc.3 if the gate fails. The detection and the warning ship either way.
- The pixel functions and the synthetic scans (Flate and JPEG, skew, merged words, abstain cases, page strips) run in CI. Tests against real scans skip when the fixture is absent.
- The tarball grows by the three WASM files. The package test asserts which files are present.
- The producer is per document, so a packet in which only an exhibit went through Paper Capture flags every native page that has a full-page background image; and a re-saved ClearScan file whose Info and XMP were both overwritten loses ClearScan detection.
- XMP written in attribute form (`<rdf:Description pdf:Producer="..."/>`) is not read, because PDF.js parses only child elements; the element form is.
- Word breaks recorded by the text layer (empty text items) are honoured only on pages classified as OCR scans. In native PDFs they are layout filler, and trusting them splits `[word]` on New York bills.
- `scan.pages` lists only scanned pages; a page not listed is native.
- Known limits: axis-aligned pages only, and no handwriting. A hand-drawn strike is read only if it forms a clear horizontal run.
