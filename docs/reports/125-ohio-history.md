# Ohio history adapter spike and implementation (#125)

Observed on 2026-10-14. Live HTML was saved outside the repository for inspection;
no downloaded legislation or real page HTML is included in the change.

## What Ohio publishes

The honest User-Agent built from `BRAND.name`, `BRAND.version` and
`BRAND.repositoryUrl` received HTTP 200 for status, documents and committee pages
for the three Ohio manifest fixtures, and for HB 33 of the 135th General Assembly.

- [HB 62 documents](https://www.legislature.ohio.gov/legislation/135/hb62/documents),
  [SB 113 documents](https://www.legislature.ohio.gov/legislation/136/sb113/documents)
  and [SB 203 documents](https://www.legislature.ohio.gov/legislation/133/sb203/documents)
  list `00_IN` (As Introduced).
- [HB 33 documents](https://www.legislature.ohio.gov/legislation/135/hb33/documents)
  list `06_EN`, `05_CR`, `04_PS`, `03_RS`, `02_PH`, `01_RH`, `00_IN`, newest first.
  These are enrolled, conference report, Senate passed/reported, House
  passed/reported and introduced text. The page itself has no publication dates.
  The [status page](https://www.legislature.ohio.gov/legislation/135/hb33/status)
  dates introduction, committee reports (including substitutes), passage,
  conference agreement and transmission to the governor. The adapter uses these
  matching stage dates; an enrolled entry uses transmission to the governor,
  not an inferred signing/publication date. Unmatched dates remain absent.
- [HB 68 documents](https://www.legislature.ohio.gov/legislation/135/hb68/documents)
  and [HB 2 documents](https://www.legislature.ohio.gov/legislation/135/hb2/documents)
  list “Synopsis of Committee Amendments” and a separate “Sub Bill Comparative
  Synopsis.” The amendment synopsis anchors use a `/download?key=...` URL.
  Their listings do not state a date, committee name, adoption status or offerer.
  The adapter retains each amendment document's own label and URL, gives it a
  stable URL slug and `unknown` status, and supplies no sponsor or committee.
  Comparison documents are omitted per the orchestrator decision; #130 covers
  version comparisons. Amendment PDFs are never fetched or inspected here.
- HB 33's status says “Reported - Substitute” and mentions Senate amendments and
  conference managers. These remain actions. They do not establish who offered
  an individual amendment. A sponsor, witness, or conference manager is never
  assigned as an amendment's sponsor.
- Current sponsor anchors on SB 113 point to Ohio Senate member pages. Archived
  sponsor/cosponsor records on HB 62, HB 33 and SB 203 contain names only. Current
  anchors become verified legislature links and their member path supplies
  `memberId`; archived names get empty links. No name lookup is performed.
- Committee pages have dated `.committee-meeting-table` rows, distinct from
  testimony tables. Some HB 33 rows leave status blank: these are retained as
  “Committee meeting,” without inventing a numbered hearing. Committee chamber
  comes from the page's “House Committees” or “Senate Committees” heading.

## Design and validation

Ohio is one source in the existing registry. Resolvers accept anchored legislature
landing URLs (including status/documents/committee suffixes) and LIS PDF version
URLs. Text URLs are constructed from bill identity and version code. An explicit
URL version wins; otherwise the greatest numbered stage code is selected. Dates
are unnecessary for this choice, including same-day substitutes. Parsed versions
retain the official listing order. An unreadable latest version never falls back
to an older one.

Only `www.legislature.ohio.gov` and `search-prod.lis.state.oh.us` can be fetched.
Ohio House/Senate member anchors are display links only. Existing `safeFetch`
policies still validate and pin every request and redirect. Its explicit history
page option returns HTML data instead of treating a documents page as an ingest
wrapper; it never follows an anchor. Ordinary ingest wrapper handling is retained,
including when reading a cached history snapshot as an ordinary document.

All three pages must download and parse successfully for a history attachment.
Failure preserves explicit-version text ingestion with “History unavailable.”
Versionless landing URLs instead ask for a specific LIS version URL, since choosing
text without a readable version record would require guessing.

Unit tests use small invented HTML in `tests/synth/ohio-history.ts`, injected
fetchers, the shared `MemoryBackend`/`ScriptedProvider`, and Undici's `MockAgent`.
They cover substitute order/dates, amendments without attribution, archived/current
sponsors, invalid pages/links/dates, explicit/default version selection, history
failures, wrapper handling, and redirects to untrusted/member hosts. The frozen
model contracts are unchanged. No dependency was added.

Run the local-only canary with `npm run history:canary`. It reads the three Ohio
manifest entries, fetches all three history pages through `safeFetch`, validates
parsed versions/actions/sponsors and reports each bill independently. It never
fetches bill text, amendments, comparisons or member pages; no CI job invokes it.
Its test suite is entirely offline.

On this workstation, the real canary reports failure for all three fixture bills:
Node/Undici rejects the Ohio certificate chain with
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`, including with `--use-system-ca`. macOS curl
(SecureTransport) accepts the chain and all inspected pages returned 200. Parsing
those curl snapshots succeeds for each fixture and HB 33 (7 versions, 127 actions,
58 sponsor/cosponsor profiles). TLS verification is retained; no bypass or transport
fallback is added. A live canary pass through Node remains to be verified in an
environment that can validate Ohio's certificate chain.
