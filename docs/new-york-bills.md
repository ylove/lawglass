# New York sources and bracket amendments (#281, #282)

Checked on October 25–26, 2026. Real documents are local-only snapshots in
`fixtures/downloads/`; the manifest records URLs, dates, sizes and SHA-256 hashes.

## Sources and version selection

| Pasted source                                                                              | Observation                                                                      | Ingest mapping                                                     |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `https://www.nysenate.gov/legislation/bills/2025/S1234`                                    | HTTP 403 with `curl -A 'Mozilla/5.0'`                                            | Assembly's current full text; never fetch the blocked landing page |
| Senate page ending in `S8102A` or `S8102/amendment/A`                                      | The bill/version is encoded in the path                                          | `https://legislation.nysenate.gov/pdf/bills/2025/S8102A`           |
| `https://nyassembly.gov/leg/?default_fld=&leg_video=&bn=S01234&term=2025&Summary=Y&Text=Y` | HTTP 200, keyless full-text HTML                                                 | Fixed `https://nyassembly.gov/leg/?bn=S01234&term=2025&Text=Y`     |
| Assembly URL with `bn=S08102A`                                                             | **Assembly ignored A and returned S08102B** in both the summary and printed text | Named versions go directly to the versioned Senate PDF             |
| `https://legislation.nysenate.gov/pdf/bills/2025/S1234`                                    | HTTP 200, keyless introduced-version PDF                                         | Preserve the explicitly named introduced version                   |
| `https://legislation.nysenate.gov/pdf/bills/2025/S8102A`                                   | HTTP 200, keyless amended-version PDF                                            | Preserve version A                                                 |

Both Senate and Assembly chambers work through these mappings; leading zeros,
`www` variants, fragments and unrelated display query parameters are handled.
Assembly URLs must name `bn` and `term` exactly once. Unsupported NY routes fail
before fetching. A `/amendment/0` Senate URL explicitly selects the introduced PDF.
The Open Legislation API is not used and no API key is required.

The current Assembly lookup for S8102 returned **S08102B**; a real `safeFetch`
request for the named S8102A PDF parsed **S. 8102A, Amended (A)**. Real `safeFetch`
requests used the application's honest User-Agent, not the research browser agent.
All transport still uses its SSRF guard, pinned DNS, redirect validation, deadlines
and byte/page limits. Latest requests refresh Assembly text and do not silently
fall back to an older version on errors. This adds no NY history adapter or
legislator attribution.

Assembly's bill text is in preformatted blocks immediately after
`h3#jump_to_Text`. Only those blocks are read; menus, summaries and memos are
excluded. There are literal printed line-number gutters and repeated page headers;
they are removed without manufacturing HTML page/line citations. NY HTML uses
`<B><U>` for additions and `[<B><S>…</S></B>]` for deletions. The PDF retains bracket
characters and draws underline rules. Titles, chamber/bill numbers, session,
amendment letter and printed sponsors are read deterministically.

## Convention and literal brackets

The parser has two internal policies, `default` and `bracket-underline`. The latter
requires an exact NY/NJ source host or an explicit parser jurisdiction **and** the
matching full legend. Whitespace may wrap anywhere in the sentence. Without that
legend the existing markup/geometry rules remain in force. When brackets are present
on a NY/NJ source without its full legend, a warning explains that bracketed wording
could not be marked as removed.

The verified legends are:

- NY S1234: `EXPLANATION--Matter in italics (underscored) is new; matter in brackets [ ] is old law to be omitted.`
- NJ S1446 R2: `EXPLANATION – Matter enclosed in bold-faced brackets [thus] in the above bill is not enacted and is intended to be omitted in the law. Matter underlined thus is new matter` (no final period in this PDF).

Legend sentences are removed before scanning. A stack matches nested brackets
across elements, lines and pages. The entire outer run, including brackets, becomes
`deleted` before section detection, so deleted section numbers/headings cannot
name current sections. Existing strike/deletion status takes precedence over
insertions. An unclosed bracket deletes only up to the next section heading,
page break or blank paragraph (or document end) and warns. Balanced deletions still
cross section headings and pages. An unmatched closing bracket warns.

NY's legend makes underline and italic/oblique text additions. NJ's legend says
**underline only**: its ordinary italic enacting clause stays unchanged. PDF italic
font names are read only for NY sources, and existing underline geometry is reused.
NJ numeric `<sup>` markers and small raised PDF glyphs are removed when the
superscript-amendment legend is present; plain-text `1[…]1` and `²[…]²` pairs are
included with the deleted run. Superscript numbers identify committee changes,
not additional law text.

Literal exceptions are deliberately finite: `[Reserved]`, `[sic]`, and named
reprint labels. The NJ fixture prints `[Second Reprint]` on its cover. Bracketed
statute/reporter citations, section references and numbers are deletions under a
verified legend, including `[section 12]`, `[42 U.S.C. 1395]` and `see [3]`:
replacing a cross-reference is ordinary bill drafting. An outer deletion still
deletes nested literal brackets. Arbitrary
square-bracket prose cannot be distinguished perfectly from a deletion once
bold/typographic evidence has been lost; this rule is not a universal classifier.
Plain text supports bracket deletions but cannot recover absent underline/italic
information.

## Local accuracy

Deletion runs below were counted manually on rendered pages, then checked in order
against parsed spans. A run continuing across printed lines counts once. Legend
examples, reprint labels and running headers are excluded from the manual total.

| Snapshot                                                                                                | Manually counted deletions | Found | False positives |
| ------------------------------------------------------------------------------------------------------- | -------------------------: | ----: | --------------: |
| [NY S1234, introduced PDF](https://legislation.nysenate.gov/pdf/bills/2025/S1234)                       |                          4 |     4 |               0 |
| [NY S1234, Assembly HTML](https://nyassembly.gov/leg/?bn=S01234&term=2025&Text=Y)                       |                          4 |     4 |               0 |
| [NY S8102, introduced PDF, entirely new article](https://legislation.nysenate.gov/pdf/bills/2025/S8102) |                          0 |     0 |               0 |
| [NJ S1446, second reprint PDF](https://pub.njleg.gov/Bills/2024/S1500/1446_R2.PDF)                      |                         12 |    12 |               0 |

S1234's four deletions are `fifteen`, `non-voting`, `and`, `non-voting` (all on page
1). NJ's twelve are the comma, the household-member clause, `3-year`,
`rules and regulations`, the prior-property-ownership clause, `the`, `of $15,000`,
`not less than eight hours of`, `shall`, the long rulemaking clause, the
`guidance documents, and rules and regulations` clause, and `3.`. Local regression
tests assert every full deleted run, insertion spot checks, printed coordinates,
and that repealed wording does not reach current chunks/headings. S8102 adds a new
General Business Law article and has no repealed wording; its definitions are
underlined and parse as inserted.

S1234 has four substantive underlined insertion runs: all four are recovered.
Its styled opening enacting clause stays unchanged in PDF and HTML. Only that
recognized cover boilerplate is exempt from the PDF whole-line rule warning;
unrelated table/border warnings remain active. NJ has ten visually underlined insertion runs;
all ten are recovered, with one additional false positive: the unmarked fragment
`down payment assistanc`. This is a limitation in the pre-existing PDF underline
geometry. The twelve bracket deletions do not depend on that geometry. S8102's
insertions are spot-checked rather than exhaustively scored.

## Reproduction and limitations

Run `npm run fixtures:fetch -- --only ny-s1234-2025-introduced,ny-s8102-2025-introduced,nj-s1446-2024-r2,ny-s1234-2025-assembly`,
then `npm test -- src/core/parse/brackets.fixtures.test.ts`. Missing or hash-invalid
snapshots skip; synthetic tests run without network or real bill files.

NY PDFs generate new trailer `/ID` values on each response. Assembly adds random
CSS/JS cache-buster query parameters. The downloaded snapshots were compared byte
for byte after masking only those fields; the legislation was identical. The
strict fixture downloader therefore may save a fresh response as `.mismatch`,
which requires deliberate hash review rather than an automatic trust bypass.
These changing raw bytes also mean a refreshed latest URL can acquire a new raw
SHA-256 document ID despite identical legislative text. Semantic deduplication is
outside this change; the raw-byte identity contract is preserved.

Other PDF warnings remain visible, including NJ's unnumbered cover warning.
Scans without a usable text layer retain the existing scan failure. No contracts
in `src/core/model/` changed.

## Review regressions (#292)

NY metadata requires an official NY host, or a state/chamber header in the first
2,000 characters together with the full NY legend. A federal document mentioning
`STATE OF NEW YORK`, including a notary jurat, keeps empty metadata. A parser
jurisdiction hint alone cannot establish structured NY metadata.

Senate landing hosts (`nysenate.gov`, `www.nysenate.gov`) remain accepted pasted
inputs for the resolver but are rejected by the fetch-host check. Assembly and
`legislation.nysenate.gov` remain official text fetch hosts.

`tests/synth/brackets.test.ts` covers replaced section/statute/reporter/numeric
references under both legends, missing-legend NY warnings in text/HTML/PDF, and
NY PDF enacting boilerplate. Adjacent parser tests cover metadata scoping,
unclosed-bracket recovery with preserved later sections/coordinates, editorial
labels, HTML boilerplate and unrelated PDF rule warnings. Host-policy tests
separately exercise pasted and fetched Senate URLs. These tests use no network
or downloaded legislation. The local fixture tests still assert every deletion
run against the manual list above; the recount after the fixes remains 4/4, 4/4,
0/0 and 12/12, with zero deletion false positives.

## Structure fix (#283)

A live A5000 ingest read a wrapped line starting `chapter 397 of the laws of 2021` as a
Chapter heading and nested the following bill sections under it. NY (and NJ) bills now
use only the bill's own section markers as containers: `Section 1.` / `§ N.` with a plain
integer that continues the sequence (a quoted `§ 424-c.` or `§ 1200.` stays text), `1.`
and `(a)` as subdivisions. `article`/`chapter` patterns are never used, and a section
heading is kept only as a short leading phrase ending in a period (`Short Title.`),
never the rest of the first line. Subdivision numbers inside quoted statutes are limited
to one or two digits. Regressions: `src/core/parse/new-york.test.ts` and the local
`ny-a5000-2025-assembly` fixture.

The same quoted-section rules as New Jersey apply to NY: after "Section 3 of the ... law is
amended to read as follows:", the quoted `§ 3.` is a container inside the bill section, `§ 1-a.`
follows `§ 1`, and numbering restarts at each `PART`. On S8102 the quoted new-article sections
are `sec-1/1509`..`sec-1/1514` with their subdivisions beneath (`sec-1/1514/4`), not a deepening
`sec-1/8/3/3/4` chain.
