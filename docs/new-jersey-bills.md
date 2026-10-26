# New Jersey sources and bracket amendments (#283)

Checked on October 26, 2026. Real documents are local-only snapshots in
`fixtures/downloads/`; the manifest records URLs, dates, sizes and SHA-256 hashes.

## Sources and version selection

The bill page (`https://www.njleg.state.nj.us/bill-search/2026/S1000`) is a script-rendered
shell with no text in it. The site reads its own keyless JSON, so the resolver does too:

`GET https://www.njleg.state.nj.us/api/billDetailHist/billText/S1000/2026`

The `Hist` route works for every session including the current one (the plain
`billDetail` route ignores the year and always answers for the current session). The last
path segment is the **session's first year** (2024 for 2024-2025); an odd year in a pasted
URL is rounded down. A bill with no text returns `[]`, which is reported as "no published
bill text yet".

| Pasted source                                                                         | Ingest mapping                                            |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `njleg.state.nj.us` / `njleg.gov` (with or without `www`) `/bill-search/<year>/S1000` | JSON lookup, then the newest `_I`/`_T`/`_R` version's PDF |
| the same page with `/bill-text?f=S1500&n=1446_R2`                                     | The named version's PDF (no JSON lookup)                  |
| `pub.njleg.gov` or `pub.njleg.state.nj.us` `/Bills/<year>/<folder>/<n>_R1.HTM\|PDF`   | The same version's PDF                                    |
| legacy `njleg.state.nj.us/<year>/Bills/<folder>/<n>_R1.HTM`                           | The same version's PDF on `pub.njleg.gov`                 |
| `_S1` statements, `_E1` fiscal estimates, `_V1` vetoes, `AL`/`PL` law copies          | Refused: not bill text and without change marks           |

Version rows come from the JSON, never from a built path: the folder can differ from the
bill number (S100 lives in `/Bills/2026/S0500/100_I1.HTM`). Only `Bills/<session>/<folder>/
<number>_I<n>|R<n>` rows for the same bill and session are candidates; the highest reprint
number wins, otherwise the introduced text. All hosts are matched exactly; query
parameters other than `f`/`n` are ignored and the JSON and text requests go through the
same SSRF-guarded `safeFetch`, with the text host check applied to every redirect.

## Why the PDF

NJ's HTML (Word export, windows-1252) marks new text with `<u>` and deleted words as plain
text between bold brackets, but it **does not contain the legend**. The PDF's last page
does: "EXPLANATION – Matter enclosed in bold-faced brackets [thus] in the above bill is
not enacted and is intended to be omitted in the law. Matter underlined thus is new
matter." The bracket convention is only switched on when that full legend is present, so
the PDF is the source that can be read safely and without a guessed rule. Any HTML twin
(including an explicitly pasted `.HTM` link) is therefore mapped to its PDF. A raw HTML
file opened another way keeps its underline as insertions, leaves brackets as text and
warns that bracketed wording could not be marked as removed; it never infers the legend
from the host or the header.

## Convention, structure and metadata

- Brackets and underline follow `docs/new-york-bills.md` ("Convention and literal
  brackets"): NJ host or parser jurisdiction plus the full NJ legend, nested stack,
  cross-page runs, an unclosed bracket bounded at the next section/page/blank line.
  Committee-amendment superscript digits are removed when the superscript legend is
  present. The cover label `[First Reprint]` and the running header `S1000 [1R] SPONSOR`
  are editorial, not deletions; the header exception requires the bill designation in front
  of the bracket.
- Structure: the bill's own sections (`1.`, `2.`, numbered in sequence) are the only
  top-level containers. `a.`, `(1)`, `(a)`, `(i)` nest by sequence rather than by indent,
  because NJ prints them all at the same indent and reuses letters between `a.` and
  `(a)`. A bill section heading is kept only if it is a short leading phrase ending in a
  period. The explanatory `STATEMENT` after the last section is its own top-level block.
- Metadata (`New Jersey`): bill number (`S. 1000`), `221st Legislature`, version
  (`Introduced` or the printed `First Reprint` etc.), the primary sponsors as printed minus
  the title (co-sponsors are not listed) and the `AN ACT concerning ...` title with
  bracketed wording removed. Metadata is read only from a document with the `SENATE|ASSEMBLY,
No. N` and `STATE OF NEW JERSEY` lines **and** either an NJ source host or the full legend.
- Statute references in the text (`R.S.37:1-13`, `N.J.S.A. 2C:12-1`, `C.55:14K-104`,
  `P.L.2023, c.78`) become `state_code` external references for NJ bills.

## Local accuracy

Counted by hand on the official HTML twin of each PDF (bold brackets and `<u>` runs), then
checked in order against the PDF parse. The `[First Reprint]` label is excluded.

| Snapshot                                                                               | Deletions counted | Found | False positives | Insertions counted | Found |
| -------------------------------------------------------------------------------------- | ----------------: | ----: | --------------: | -----------------: | ----: |
| [S1446 R2](https://pub.njleg.gov/Bills/2024/S1500/1446_R2.PDF) (from #292)             |                12 |    12 |               0 |                 10 |    10 |
| [S1000 2024 R1](https://pub.njleg.gov/Bills/2024/S1000/1000_R1.PDF)                    |                 2 |     2 |               0 |                  5 |     5 |
| [S1000 2026 I1](https://pub.njleg.gov/Bills/2026/S1000/1000_I1.PDF), underline only    |                 0 |     0 |               0 |                  1 |     1 |
| [A3000 2026 I1](https://pub.njleg.gov/Bills/2026/A3000/3000_I1.PDF), new law, no marks |                 0 |     0 |               0 |                  0 |     0 |

S1446 R2 keeps the known `down payment assistanc` underline-geometry false positive from
the NY doc. The run-in "S1000 [1R]" header was a false deletion before this change and is
now unchanged. Run `npm run fixtures:fetch -- --only nj-s1000-2024-r1,nj-s1000-2026-i1,nj-a3000-2026-i1,nj-s1446-2024-r2`
then `npm test -- src/core/parse/brackets.fixtures.test.ts`; missing snapshots skip.

## Left out

Resolutions (`SJR`, `ACR`, ...), conditional-veto-only text, enacted `PL`/`AL` copies
(no change marks), committee statements, history and sponsor attribution are not read.
The "Matter enclosed in superscript numerals..." footnote on reprints is printed at the
foot of a page and can fall mid-sentence; it and its committee-amendment list are removed
from law text (the explanatory line plus the `Senate`/`Assembly ... adopted <date>.` entries).
`_T1` (technical review of a prefiled bill) is bill text: it ranks above `_I1` and below
reprints, and its version label is "Technical Review".

## Review fixes (#306)

- Quoted statute numbers: after a section that says "Section 2 of P.L.1985 ... is amended
  to read as follows:", the quoted law's own `2.` is not the bill's next section unless its
  opening also reads like an amending section (`is amended`, `(New section)`, `take effect`,
  `severability`). A rejected marker becomes a child container of the current bill section
  (`sec-1/2`), and its `a.`/`(1)`/`1.` subdivisions nest under it. `§ 1-a.` follows `§ 1`,
  and a `PART X` line restarts numbering. A4 R2 now has all 39 sections, `sec-1/2`,
  `sec-2/4`; before, `sec-3` was missing and `sec-4` had duplicate children.
- A bill page's JSON lookup failing for any reason (including an HTML outage page) is
  `FETCH_FAILED`, never a page-link offer. A folder whose house letter differs from the bill
  (`A1500` for `S1446`) is ignored.
- A wrapped `b. of this section` cross-reference is not subsection `b.`.
