# 0006: Reading amendments from PDF geometry

**Status:** accepted (2026-10-13), issue #17

## Context

State bills that amend existing law show the change only visually. Struck-through text is language being repealed, and underlined text is language being added. A PDF's text layer holds both, character for character the same as the text around them. The only evidence is a thin rule drawn near the glyphs. A parser that misses a strike presents repealed law as current law, which is the failure this tool exists to prevent.

We measured the real Ohio fixtures with PDF.js before choosing any threshold: `oh-sb113-136-in` (written by pypdf), `oh-sb203-133-in` and `oh-hb62-135-in` (both written by OpenOffice).

- **Marks are ordinary paths.** Each underline is its own stroked `moveTo`/`lineTo` under a `transform`, 0.5 to 0.7pt wide, drawn per line run. Ohio does not use font decorations, annotations or glyph overlays. (SB 113 also tags runs `base_insert`, but SB 203 has no tags, so geometry has to be the signal.)
- **Underlines sit deeper than expected.** They are 1.4pt below the baseline in SB 203 and 2.7pt in SB 113 (0.13em and 0.26em at 10.5pt). The underline runs on over one trailing space (0.6em).
- **Line numbers are in the right margin** (x = 547pt) and count on across pages: page 2 starts at 18. Our synthetic samples put them on the left and restart each page.
- **Real negative controls exist.** Each bill has a decorative bar on page 1 (a 2.5pt stroke and a 2.4pt fill) and a two-line running header.
- **Indentation is uniform.** Every paragraph's first line is indented to 111pt at every level, and wrapped lines return to the 75pt margin. A wrapped line can start "(F) of that section".
- **Strikes sit where typography predicts.** SB 113 and SB 203 only add language: all 636 of their thin rules sit below the baseline. HB 62 strikes and inserts. Its 37 strikes are 0.7pt strokes 2.7pt above the baseline (0.257em at 10.5pt), the same height as Word's strikeout. It parses to exactly the 26 struck and 28 underlined runs a researcher counted on the rendered pages.
- **Font metrics are unreliable.** PDF.js reports an ascent of 0.683em for Times-Roman (its cap height) and 0.833em for Ohio's Courier.

## Decision

All vertical thresholds are measured from the baseline in ems of the text item's own font size, so they hold at any point size. Constants live in `GEOMETRY` (`src/core/parse/pdf-geometry.ts`) and `LAYOUT` (`pdf-lines.ts`).

| Rule                   | Value                                                                                      | Why                                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Glyph box              | −0.2em to +0.8em, fixed                                                                    | PDF.js's own default ascent. Using a fixed box keeps the bands from moving with unreliable font metrics.                                                                                                                                                                                         |
| Strikethrough          | centre in the box's middle third: +0.133em to +0.467em                                     | Word and the common fonts (Times New Roman, Arial, Courier New) put strikeout near 0.26em. A naive "middle third of the em" (0.33 to 0.67em) would miss them.                                                                                                                                    |
| Underline              | centre from −0.35em to +0.05em                                                             | This covers both Ohio depths. A fixed "0 to 2.5pt below" would miss every SB 113 underline (2.7pt).                                                                                                                                                                                              |
| Between or above bands | leave unchanged, warn                                                                      | Too unclear to call either way, so a person should look.                                                                                                                                                                                                                                         |
| Thickness              | at most max(1.5pt, 0.15em), including the stroke width; up to 0.5em, warn; thicker, ignore | Typographic rules are about 0.05em thick (Word) to 0.07em (Ohio), so the cap scales with the text: a 3pt strike through 48pt text is a strike. A heavier in-band rule is not marked, but it gets a warning rather than being dropped silently. Anything over half an em is a highlight or a box. |
| Hairline               | under 0.2pt in a band: leave unchanged, warn                                               | Table grid lines are hairlines (often PDF line width 0); no typographic strike is that thin at body sizes.                                                                                                                                                                                       |
| Paint                  | ignore paint with under 10% ink against white, after opacity                               | A white cover-up rectangle or a transparent rule leaves nothing visible. PDF.js reports every colour space as RGB; opacity comes from the graphics state.                                                                                                                                        |
| Shape                  | each subpath: no curves, wider than tall; a stroke-only outline must be flat (≤ 1pt)       | Admits strokes and thin bars. Rejects boxes and table cells, because their sides give them height.                                                                                                                                                                                               |
| Links                  | ignore a rule in the lowest 35% of a link annotation's area                                | A hyperlink's underline is styling. A strike through a link (higher in the area) still counts.                                                                                                                                                                                                   |
| Whole-line rule        | warn when one rule marks every glyph of a line outside the body text                       | A table rule just under a row looks exactly like a whole-line underline. Body text (numbered lines, or the common indents when unnumbered) is not questioned, since Ohio underlines whole new sections line by line.                                                                             |
| Coverage               | the mark covers ≥ 70% of a **glyph**                                                       | The spec's 70%, applied per glyph rather than per text item. PDF.js merges adjacent runs into one item, so a per-item rule would mark words the line never touched. Glyph widths come from the page's own text-showing operators.                                                                |
| Overhang               | ignore a rule that runs > 1.5em past the line's text                                       | A table rule through text extends past it. Ohio's run-on is 0.6em.                                                                                                                                                                                                                               |
| Whitespace             | gets a status only if the text on both sides has it                                        | A rule through a word gap marks nothing, and a run-on over a trailing space does not leak into the next word.                                                                                                                                                                                    |
| Struck and underlined  | deleted, with a warning                                                                    | Calling repealed text current is the worse error.                                                                                                                                                                                                                                                |
| Other annotations      | ignored                                                                                    | A reviewer's StrikeOut annotation is reader markup, not the bill's amendment.                                                                                                                                                                                                                    |

**Layout:**

- **Line numbers.** A page's band is a set of 1-6 digit items that align on one edge, so left- and right-aligned numbers both work. All of them must sit in the same margin, judged against the other items on their baseline. There must be at least three, and they must count up by exactly one for at least 80% of steps. A page too short to establish a band reuses the band most pages share. Each printed line takes the number within 0.5em of its baseline, recorded as printed.
- **Running headers and footers.** These are unnumbered lines in the top or bottom 15% of the page that are either page numbers or text that repeats, ignoring digits, within 2pt of the same baseline on at least half the pages (and at least two). A numbered line is body text and is never removed.
- **Structure from the amended text.** Sections are detected on the text with struck characters removed. Struck characters still go into spans, as `deleted` runs. A struck heading or relettered marker (`~~(C)~~ (D)`) therefore never names a section, so repealed language cannot reach a `heading`, a breadcrumb or an embedding. A line that is struck entirely stays in the section where it was printed.
- **Indentation.** In a first-line-indent layout (at least 75% of heading-like lines indented past the margin), a line at the margin is a wrapped continuation and never opens a section. Indentation is passed on as nesting evidence only when different levels start at different indents. Ohio's uniform indent would otherwise mislead the `(i)` letter-versus-numeral rule.
- **Overprint.** The same string drawn again within 1pt of itself (fake bold) is read once.
- **Columns.** Lines are read straight across. A page where at least three lines (and a quarter of them) share a gap wider than 4em at the same x gets a "two columns (or a table)" warning.
- **No text layer.** A page with any text is not a scan, however short ("HB 5" on a cover). The parser throws `SCANNED_PDF` (the spec's message) only when the document paints images and no page has 50 visible characters. A document with no text and no images throws `PARSE_FAILED`. A page with no text but an image gets a warning.

**Loading PDF.js.** PDF.js is loaded on first use, and its worker runs on this thread from the imported module, not a file path. Standard-font files are not loaded (`useSystemFonts`): PDF.js has the metrics built in, and text, glyph widths and paths are identical without them across all 16 PDFs we checked. So the parser needs no files from the PDF.js package at run time. The CLI build inlines PDF.js (tsup `noExternal`), and it stays a devDependency. As a dependency, every `npx` install fetched 61.8MB: 34.9MB of `pdfjs-dist`, plus 26.9MB for its optional `@napi-rs/canvas`, which only rendering uses. An npm `overrides` stub would not help, since npm ignores overrides in installed packages. Without canvas, PDF.js logs three notices as it loads. They concern rendering only, so they are filtered while it loads.

## Consequences

- CI checks every case with the synthetic `makeAmendmentGeometryPdf()`:
  - strokes and thin rectangles;
  - the generator's, Word's and Ohio's offsets;
  - marks inside merged runs, down to one struck comma;
  - wraps across a line and across a page break;
  - struck headings;
  - eight negative controls.
- Local tests spot-check six sections of SB 113 and SB 203 against strings read off the rendered pages. They also check HB 62's struck and inserted phrases, and that no struck text reaches a non-deleted chunk's heading, breadcrumb or embedding.
- **Known limits.** These are each a follow-up issue if a real bill needs it:
  - single-column reading order only (two-column pages are flagged, not reordered);
  - line numbers must step by one, so "every fifth line" numbering is not read;
  - glyph positions ignore kerning inside a merged run;
  - rotated text, such as stamps, is skipped with a warning;
  - a wholly struck section heading opens no section, so its text attaches to the previous section's breadcrumb as deleted text;
  - a hairline strike, or an underline that is also a table rule, is flagged for a person rather than decided.
