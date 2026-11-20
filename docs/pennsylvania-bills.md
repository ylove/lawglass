# Pennsylvania sources and bracket amendments (#422)

Checked on November 19, 2026, from a laptop with `curl` and a browser user agent, a request
about every second. Real documents are local-only snapshots in `fixtures/downloads/`; the
manifest records URLs, dates, sizes and SHA-256 hashes.

## What is supported

Pennsylvania publishes four kinds of numbered measure, and every one has official text:

| Type              | Number on the site | Cover line                           | Supported |
| ----------------- | ------------------ | ------------------------------------ | --------- |
| House bill        | `HB 2443`          | `HOUSE BILL` / `AN ACT`              | Yes       |
| Senate bill       | `SB 1273`          | `SENATE BILL` / `AN ACT`             | Yes       |
| House resolution  | `HR 607`           | `HOUSE RESOLUTION` / `A RESOLUTION`  | Yes       |
| Senate resolution | `SR 374`           | `SENATE RESOLUTION` / `A RESOLUTION` | Yes       |

Two further kinds have no number series of their own, so they are reached through the four
above and need no extra routes:

- **Joint resolutions** (constitutional amendments) are numbered as bills (`SB 605`, `HB 900`)
  and print `A JOINT RESOLUTION` under the bill line. They are read as resolutions
  (`docKind: resolution`), with their underlined new section read as inserted.
- **Concurrent resolutions** are numbered as House or Senate resolutions (`HR 125`) and print
  `A CONCURRENT RESOLUTION`. Also read as resolutions.

`/legislation/bills/2025/hjr1`, `sjr1`, `hcr1` and `scr1` are 404s on the site: there is no
`HJR`, `SJR`, `HCR` or `SCR` series. The site's own search offers only "Bills" and
"Resolutions" by House or Senate. Special sessions (`2023-2024 Special Session #1`, and
earlier ones) use the same shapes with a session index of 1 to 3 and are supported.

## Sources and version selection

| Pasted source                                                                                                                 | Observation                                                                             | Ingest mapping                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `https://www.palegis.us/legislation/bills/2025/hb2443` (also `palegis.us`, zero-padded, `/2023/1/hb1` for special session #1) | HTTP 200, server-rendered HTML, no script needed                                        | Read the page, take the newest printer's number's PDF |
| `.../legislation/bills/text/PDF\|HTM\|DOC/2025/0/HB2443/PN4082`                                                               | PDF is `application/pdf`; HTM is `text/html`; DOC is `application/msword`; no redirects | The same printer's number's PDF                       |
| `https://www.legis.state.pa.us/cfdocs/...btCheck.cfm?...&pn=4082` or `billinfo.cfm?...`                                       | HTTP 301 to a `newSiteRedirect.cfm` page that lands on palegis.us                       | Same mapping, never fetched from the old host         |
| `https://www.legis.state.pa.us/WU01/LI/BI/BT/2025/0/HB2443P4082.pdf`                                                          | HTTP 301, same redirector                                                               | The same printer's number's PDF                       |
| `.../WU01/LI/BI/FN/...` or `SFN/...` (fiscal notes)                                                                           | HTTP 200 PDF, no change marks                                                           | Refused: not bill text                                |
| `https://palegis.us/...`                                                                                                      | HTTP 301 to `www.palegis.us`                                                            | Resolved to the `www` host before any fetch           |

**Printer's numbers.** Each print of a bill has a printer's number (`PN`), and a bill's
amendments in a chamber get a new one. The bill page lists every one as a link, so the
resolver reads the page once and takes the **highest** number for that exact bill, session
and year (they only increase: PN 3253, 3616, 4082 for HB 2443). Links to other bills in the
page's navigation are ignored. A pasted text link keeps the printer's number it names.

**Padding.** Text paths are zero-padded to four digits (`SR0374`, `PN0613`); `SR374` and
`PN613` are 404s. Letter case does not matter (`sr0374/pn1942` works). Page paths do not need
padding (`sr374`, `hr001` and `hb0001` all work). A bill that does not exist redirects (302)
to `/404`, which the resolver reports as "no published bill text".

**Session in the path.** The year is the session's first year (2025 for 2025-2026) and a
single digit follows it: 0 regular, 1 to 3 special. The printed "Session of 2026" on the
cover is the year the copy was printed, so metadata takes the session from the URL.

## Why the PDF

The HTML text export (`LDPC HTMLEX Generator`, a `pdf2htmlEX` page) is the PDF re-laid out as
absolutely positioned boxes, about 2.3 times the PDF's size, and gives no usable underline or
strike-through. The PDF draws both as rules, which the PDF geometry parser already reads (as
for Ohio). Every format is therefore mapped to the PDF. The Word file is not used.

## Convention: family F3, plus strike-out and capitals

Pennsylvania prints no legend on the bill. The legislature explains its marks on a help page,
"Explanation to facilitate reading of legislative bills"
(`https://www.legis.state.pa.us/WU01/LI/BI/how_to_read.htm`):

> **[Light face brackets]** are used only in bills amending an existing law. They indicate
> that anything enclosed thereby appears in the existing law, but that it is proposed to omit
> it from the law as amended.
>
> **Underscoring** is used only in bills amending an existing law. It indicates that the
> underscored matter does not appear in the existing law, but that it is proposed to insert
> it in the law as amended.
>
> **Strike out type** is used only in bills that have been amended either in committee or on
> the floor of either House. They indicate that anything so printed appeared in a previous
> print of the bill but is to be deleted.
>
> **CAPITAL LETTERS** are used only in bills that have been amended ... They indicate that the
> matter in capital letters did not appear in the original print of the bill, but was inserted
> into the bill by amendment ... unless it is also underscored, in which case it will be
> printed in italics.

It also lists ellipses (`* * *`, omitted unchanged law) and dark face brackets (the same
effect as light face brackets, added by an amendment).

| Mark                | Meaning                  | How it is read                                                                         |
| ------------------- | ------------------------ | -------------------------------------------------------------------------------------- |
| `[words]`           | Old law omitted          | Deleted, once the gate below passes (the brackets are in the text layer)               |
| Underline           | New law                  | Inserted (drawn rule, read by the PDF geometry parser)                                 |
| Strike-through      | Removed by an amendment  | Deleted (drawn rule)                                                                   |
| `CAPITAL LETTERS`   | Added by an amendment    | Inserted, only in an amended print and only for a run of two or more capitalised words |
| `<--` in the margin | Points at a changed line | Removed from the text                                                                  |
| `* * *`             | Unchanged law left out   | Kept as printed                                                                        |

**Gate instead of a legend.** The NY and NJ bracket rule is switched on by a printed legend.
Pennsylvania has none, so the rule is switched on by the page itself: the host is a
Pennsylvania source (or the parser is told the jurisdiction), the text opens with `THE
GENERAL ASSEMBLY OF PENNSYLVANIA`, and the bill says it amends something (`Amending ...`,
`is amended`, `be amended`). This follows the legislature's own statement that brackets are
used only in bills amending existing law: in a new act or a resolution a bracket is ordinary
text (`[sic]`) and stays unchanged. A Pennsylvania document with brackets and no cover gets the
same "bracketed wording could not be marked as removed" warning New York and New Jersey get;
a cover that amends nothing gets none.

Shared with NY/NJ: nested brackets, runs that cross pages, and an unclosed bracket being
bounded at the next section, page or blank line. Three Pennsylvania-only repairs run first:
the `<--` pointers are dropped; the cover lines above the title (`PRINTER'S NO. 4082`,
`PRIOR PRINTER'S NOS. 3253, 3616`) are printed over a rule that reads as underline, so they
are kept unchanged; and in a print that lists prior printer's numbers, a run of capitalised
words is an insertion. The capitals rule is a heuristic on purpose limited: an amended **new
act** has no underline, so its added words otherwise could not be told from existing text. A
single capitalised word, an acronym or a heading is not read as an insertion.

Text that is struck through **and** underlined (a word added by one amendment and removed by
the next) is treated as deleted, and the PDF parser says so in a warning. Amended prints
carry it often, so it is a known noisy warning.

## Structure and metadata

- Structure: `Section 1.` (bill sections) and `§ 8117.` (quoted statute sections) are in the
  default patterns, and the heading is kept only if it is a short phrase ending in a period.
  There is no NY/NJ-style gate: an inline "(3) and (4)" that wraps to a line start can still
  open a subsection, which only affects citation labels, never the text or its marks.
- Metadata (`Pennsylvania`), read from the PDF cover with struck words removed: number
  (`HB 2443`, `SR 374`), session from the URL (`2025-2026 Regular Session`, or
  `Special Session #1`), version (`Printer's No. 4082`), the prime sponsor (the first name
  after `INTRODUCED BY`; the cosponsor list can run to fifty names) and the title (the lines
  after `AN ACT` / `A RESOLUTION` up to the enacting or first `WHEREAS` line). A resolution,
  joint resolution or concurrent resolution is `docKind: resolution`. Metadata needs the
  `THE GENERAL ASSEMBLY OF PENNSYLVANIA`, chamber and `No. N` lines **and** either a PA host
  or an amending bill. The bill page's own metadata is not fetched.

## Fetch notes

- **A plain `curl` is 403.** The default curl user agent gets HTTP 403 on every page and PDF;
  any browser agent and Lawglass's own agent (`lawglass/<version> (+repository)`) get 200. No
  429 was seen at one request a second. No cookie or script is needed (the cookies set are
  ignored).
- The bill page is about 50 to 160 KB, mostly links, so it is fetched with the link-hub
  heuristic switched off (it is read for printer's numbers, never indexed) and with a refresh,
  so a new print is seen.
- The fetch policy allows only `www.palegis.us` and `palegis.us`, only a bill page, a
  `/text/PDF/` path or `/404`, over https on the default port. `legis.state.pa.us` is accepted
  as pasted input and mapped, never fetched.

## Local accuracy

Counted on the extracted text layer and the drawn rules of each PDF; bracket pairs were
checked against the printed brackets. For HB 150 the whole-section bracket and the page-by-page
marks were checked; its eleven short struck runs (mostly cross-references such as `(a)(2)`) are
the parser's reading of the drawn rules and were not each re-read on the rendered page. Run `npm run fixtures:fetch -- --only pa-hb170-2025-pn2721,pa-sb1273-2025-pn1610,pa-hb150-2025-pn2066,pa-hb2443-2025-pn4082,pa-sr374-2025-pn1942,pa-hr607-2025-pn3853,pa-sb605-2025-pn0613,pa-hr125-2025-pn1009`
then `npm test -- src/core/parse/pennsylvania.fixtures.test.ts`; missing snapshots skip.

| Snapshot                                                                                  | Kind                            |                             Deletions counted | Found | False positives | Insertion runs counted | Found |
| ----------------------------------------------------------------------------------------- | ------------------------------- | --------------------------------------------: | ----: | --------------: | ---------------------: | ----: |
| [HB 170 PN 2721](https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB0170/PN2721)  | Amends Title 75                 |                                             2 |     2 |               0 |                      4 |     4 |
| [SB 1273 PN 1610](https://www.palegis.us/legislation/bills/text/PDF/2025/0/SB1273/PN1610) | Adds new law only               |                                             0 |     0 |               0 |                      1 |     1 |
| [HB 150 PN 2066](https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB0150/PN2066)  | Repeals section 9777, adds 9778 | 12 (the bracketed section and 11 struck runs) |    12 |               0 |                     12 |    12 |
| [HB 2443 PN 4082](https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB2443/PN4082) | Senate-amended new act          |                                             4 |     4 |               0 |                      1 |     1 |
| [SR 374 PN 1942](https://www.palegis.us/legislation/bills/text/PDF/2025/0/SR0374/PN1942)  | Senate resolution               |                                             0 |     0 |               0 |                      0 |     0 |
| [HR 607 PN 3853](https://www.palegis.us/legislation/bills/text/PDF/2025/0/HR0607/PN3853)  | House resolution                |                                             0 |     0 |               0 |                      0 |     0 |
| [SB 605 PN 613](https://www.palegis.us/legislation/bills/text/PDF/2025/0/SB0605/PN0613)   | Joint resolution                |                                             0 |     0 |               0 |                      1 |     1 |
| [HR 125 PN 1009](https://www.palegis.us/legislation/bills/text/PDF/2025/0/HR0125/PN1009)  | Concurrent resolution           |                                             0 |     0 |               0 |                      0 |     0 |

HB 170's current-law text reads cleanly ("farm vehicles for which a Type D, Type AA, Type BB or
Type CC biennial certificate of exemption has been issued"). A further sweep of 24 bills and
resolutions (HB, SB, HR and SR from numbers 100 to 2300) parsed with no leftover bracket
characters in current text and no unclosed-bracket warning, including an appropriations bill
and a constitutional amendment.

## Left out

Amendment pages, fiscal notes, sponsor memos, bill history and legislator attribution are not
read; Pennsylvania has no history adapter and no sponsor profiles yet. Statute references
(`42 Pa.C.S. § 9799.14`, `the act of December 18, 2001 (P.L.949, No.114)`) are not turned into
external references. Pre-1971 measures live on a separate archive and are not read. The 2nd and
later prints are chosen by highest printer's number, which assumes numbers only increase.
