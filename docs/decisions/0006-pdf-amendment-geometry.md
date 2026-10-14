# 0006: Reading amendments from PDF geometry

**Status:** accepted (2026-10-13), issue #17

## Context

State bills that amend existing law show the change only visually. Struck-through text is language being repealed, and underlined text is language being added. A PDF's text layer holds both, character for character the same as the text around them. The only evidence is a thin rule drawn near the glyphs. A parser that misses a strike presents repealed law as current law, which is the failure this tool exists to prevent.

We measured the real Ohio fixtures with PDF.js before choosing any threshold (`oh-sb113-136-in`, written by pypdf, and `oh-sb203-133-in`, written by OpenOffice):

- **Marks are ordinary paths.** Each underline is its own stroked `moveTo`/`lineTo` under a `transform`, 0.5 to 0.7pt wide, drawn per line run. Ohio does not use font decorations, annotations or glyph overlays. (SB 113 also tags runs `base_insert`, but SB 203 has no tags, so geometry has to be the signal.)
- **Underlines sit deeper than expected.** They are 1.4pt below the baseline in SB 203 and 2.7pt in SB 113 (0.13em and 0.26em at 10.5pt). The underline runs on over one trailing space (0.6em).
- **Line numbers are in the right margin** (x = 547pt) and count on across pages: page 2 starts at 18. Our synthetic samples put them on the left and restart each page.
- **Real negative controls exist.** Each bill has a decorative bar on page 1 (a 2.5pt stroke and a 2.4pt fill) and a two-line running header.
- **Indentation is uniform.** Every paragraph's first line is indented to 111pt at every level, and wrapped lines return to the 75pt margin. A wrapped line can start "(F) of that section".
- **Neither bill strikes anything.** Both only add language. Every one of the 636 thin rules sits below the baseline, and the rendered pages confirm it. The strikethrough thresholds below therefore rest on typography and the synthetic suite, not on an Ohio sample.
- **Font metrics are unreliable.** PDF.js reports an ascent of 0.683em for Times-Roman (its cap height) and 0.833em for Ohio's Courier.

## Decision

All vertical thresholds are measured from the baseline in ems of the text item's own font size, so they hold at any point size. Constants live in `GEOMETRY` (`src/core/parse/pdf-geometry.ts`) and `LAYOUT` (`pdf-lines.ts`).

| Rule                   | Value                                                  | Why                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Glyph box              | −0.2em to +0.8em, fixed                                | PDF.js's own default ascent. Using a fixed box keeps the bands from moving with unreliable font metrics.                                                                                                                          |
| Strikethrough          | centre in the box's middle third: +0.133em to +0.467em | Word and the common fonts (Times New Roman, Arial, Courier New) put strikeout near 0.26em. A naive "middle third of the em" (0.33 to 0.67em) would miss them.                                                                     |
| Underline              | centre from −0.35em to +0.05em                         | This covers both Ohio depths. A fixed "0 to 2.5pt below" would miss every SB 113 underline (2.7pt).                                                                                                                               |
| Between or above bands | leave unchanged, warn                                  | Too unclear to call either way, so a person should look.                                                                                                                                                                          |
| Thickness              | at most 1.5pt, including the stroke width              | Rejects decorative bars (Ohio's 2.5pt) and redaction blocks.                                                                                                                                                                      |
| Shape                  | each subpath: no curves, wider than tall               | Admits strokes and thin filled bars. Rejects boxes and table cells, because their sides give them height.                                                                                                                         |
| Coverage               | the mark covers ≥ 70% of a **glyph**                   | The spec's 70%, applied per glyph rather than per text item. PDF.js merges adjacent runs into one item, so a per-item rule would mark words the line never touched. Glyph widths come from the page's own text-showing operators. |
| Overhang               | ignore a rule that runs > 1.5em past the line's text   | A table rule through text extends past it. Ohio's run-on is 0.6em.                                                                                                                                                                |
| Whitespace             | gets a status only if the text on both sides has it    | A rule through a word gap marks nothing, and a run-on over a trailing space does not leak into the next word.                                                                                                                     |
| Struck and underlined  | deleted, with a warning                                | Calling repealed text current is the worse error.                                                                                                                                                                                 |
| Annotations            | ignored                                                | A reviewer's StrikeOut annotation is reader markup, not the bill's amendment.                                                                                                                                                     |

**Layout:**

- **Line numbers.** A page's band is a set of 1-6 digit items that align on one edge, so left- and right-aligned numbers both work. All of them must sit in the same margin, judged against the other items on their baseline. There must be at least three, and they must count up by exactly one for at least 80% of steps. A page too short to establish a band reuses the band most pages share. Each printed line takes the number within 0.5em of its baseline, recorded as printed.
- **Running headers and footers.** These are unnumbered lines in the top or bottom 15% of the page that are either page numbers or text that repeats, ignoring digits, within 2pt of the same baseline on at least half the pages (and at least two). A numbered line is body text and is never removed.
- **Structure from the amended text.** Sections are detected on the text with struck characters removed. Struck characters still go into spans, as `deleted` runs. A struck heading or relettered marker (`~~(C)~~ (D)`) therefore never names a section, so repealed language cannot reach a `heading`, a breadcrumb or an embedding. A line that is struck entirely stays in the section where it was printed.
- **Indentation.** In a first-line-indent layout (at least 75% of heading-like lines indented past the margin), a line at the margin is a wrapped continuation and never opens a section. Indentation is passed on as nesting evidence only when different levels start at different indents. Ohio's uniform indent would otherwise mislead the `(i)` letter-versus-numeral rule.
- **No text layer.** If every page has fewer than 10 visible characters, the parser throws `SCANNED_PDF` with the spec's message. If only some pages do, it warns for each of those pages.

## Consequences

- CI checks every case with the synthetic `makeAmendmentGeometryPdf()`:
  - strokes and thin rectangles;
  - the generator's, Word's and Ohio's offsets;
  - marks inside merged runs, down to one struck comma;
  - wraps across a line and across a page break;
  - struck headings;
  - eight negative controls.
- Local tests spot-check six sections of the two Ohio bills against strings read off the rendered pages.
- **No real strikethrough yet.** We need an Ohio fixture that strikes text, to confirm the strike band on real output rather than on typography alone.
- **Known limits.** These are each a follow-up issue if a real bill needs it:
  - single-column reading order only;
  - line numbers must step by one, so "every fifth line" numbering is not read;
  - glyph positions ignore kerning inside a merged run;
  - rotated text, such as stamps, is skipped with a warning.
