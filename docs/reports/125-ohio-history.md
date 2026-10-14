# Ohio history adapter (#125)

Observed on 2026-10-14. No downloaded legislation or real API responses are in the
repository; tests use invented JSON in `tests/synth/ohio-history.ts`.

## TLS finding

`www.legislature.ohio.gov` fails TLS verification from Node
(`UNABLE_TO_VERIFY_LEAF_SIGNATURE`): the server sends the wrong intermediate
certificate. curl and browsers repair this through AIA fetching; Node does not.
We do not weaken verification, bundle certificates or fall back to another
transport. The host is not fetched and is not on the allowlist. Its
`/legislation/<ga>/<bill>` URLs are still recognised and mapped to the API below.

## The LIS JSON API

`search-prod.lis.state.oh.us` is the same host the bill text comes from. Node
verifies it, and it answers the honest User-Agent. All four endpoints below are
read for a history.

- `GET /api/v2/general_assembly_<ga>/legislation/<bill>/`: a JSON array with one
  object per version (`version`, `version_id`, `formatted_version`, `long_title`,
  `effective_date`, `governor_signed_date`, `concurrence_date`, `sponsors[]`,
  `cosponsors[]`, `download`). HB 33 (135th GA) has seven, `00_IN` to `06_EN`,
  returned oldest first. The code is `<formatted_version>_<version_id>`.
- `.../actions/`: dated actions with chamber and committee name (for example
  "Introduced", "Passed", "Reported - Substitute", "Conference report agreed to").
  This is the status endpoint. There is no `/status/` or `/history/` (404).
- `.../meetings/`: committee meetings with date, committee, chamber and a
  `canceled` flag.
- `.../amendments/`: `[]` for HB 33. Where present (HB 7, 136th GA) an entry has
  `amendment_number`, `version`, `sponsors[]` and a relative PDF link, but no date
  or committee.
- Members: there is no members endpoint. `/general_assembly_<ga>/legislators/`
  lists legislators (name, party, district, `member_id`) but carries no
  member-page URL. Sponsors therefore keep `memberId` and `links: []`, and the
  link builder (#123) adds labeled search links.

## Mapping

- Versions oldest first (stage order; the GovInfo adapter stores the same way), labels from the record, text URLs built from identity
  and code (never from a URL in the record). The latest is the highest code.
- Actions: the actions endpoint, each non-canceled meeting as "On the
  <committee> meeting agenda" (a notice does not prove a hearing), plus "Signed by the Governor" and "Effective date" when stated.
  Dates come from the record only. Oldest first.
- Amendments: number and a constructed PDF URL, status `unknown`. The record's
  first listed sponsor becomes `sponsor` (name and `memberId`); any others are
  named in the description. Nobody is named unless the record names them.
- No official summary: the long title is not a CRS-style summary.
- Party codes (`party_democrat_1`) map to Democrat, Republican or Independent;
  others are left out.
- Responses are validated with zod. Text fields are stripped of markup and
  control characters; consumers must still render them as text.

All four requests must succeed for a history to attach. Failure keeps explicit-
version text ingestion with "History unavailable". A versionless landing URL then
asks for a specific LIS version URL.

`npm run history:canary` (local only) checks the three Ohio fixture bills against
the live API. All three pass from Node.
