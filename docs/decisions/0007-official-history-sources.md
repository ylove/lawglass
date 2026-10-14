# 0007: Official history sources, host allowlist and an honest User-Agent

**Status:** accepted (2026-10-14), issue #118

## Context

rc.2 adds a bill's legislative history and lets people paste the page they actually have, which is usually a landing page and not the text file. Three facts shaped the design.

- **congress.gov blocks automated clients.** Its bill pages are the URLs people paste, but we cannot fetch them. GovInfo is the official bulk source for the same bills, with the text and a BILLSTATUS XML file per bill. BILLSTATUS carries the actions, committees, sponsors and the Congressional Research Service summary.
- **Ohio's pages answer an honest client.** On 2026-10-14 `www.legislature.ohio.gov` and `search-prod.lis.state.oh.us` returned 200 to a descriptive User-Agent and 403 only to curl's default.
- **Spec §5.1 says never auto-follow links.** That rule stops a page from steering our fetcher, which is an SSRF and prompt-injection risk. We want to keep it.

## Decision

- **`safeFetch` is unchanged.** It never follows a link found in a page.
- **Known landing URLs are rewritten before any fetch**, by pure, anchored string mapping (see spec Amendment 9). Nothing is read from page content.
- **The version is chosen deterministically.** If the pasted URL names one (congress.gov `/text/<code>`, or a GovInfo `BILLS-<congress><type><n><code>` URL), that version is used. Otherwise the latest text version in the official record is used: BILLSTATUS `textVersions` for federal, the Ohio documents/status page for Ohio. Only the version code comes from the record, and the URL is still built by the mapping. If the record cannot be read, ingest fails and asks the user to paste a specific version's URL. We never guess. The UI shows the version read and lists the others.
- **Unmatched congress.gov URLs are rejected before any fetch**, with a message saying what to paste. This is the one exception to today's behavior: `safeFetch` has no host exclusion, so without it `https://www.congress.gov/help` would be fetched. Every other unmatched host keeps today's behavior.
- **History adapters fetch only from an exact-host allowlist:** `www.govinfo.gov`, `www.legislature.ohio.gov`, `search-prod.lis.state.oh.us` and `unitedstates.github.io`. Hosts are compared whole, never by suffix, and none comes from user input or from a page.
- **Every fetch goes through `safeFetch`**, so the SSRF guard, the pinned IP and redirect re-validation still apply.
- **Sources are official and keyless.** Federal and Ohio only for rc.2.
- **A history failure never blocks ingest.** The text is read, and the UI says "history unavailable".
- **The User-Agent is honest.** It is built from `BRAND` (name, version, repository URL). We do not present ourselves as a browser. If a site blocks an honest client, we do not fetch from it.
- **Attribution.** History names a person or committee only when the official record does. Otherwise it says "an amendment" or "between these versions".

## Consequences

- Pasting a congress.gov or legislature.ohio.gov bill URL works without us touching congress.gov.
- Adding a jurisdiction means adding a mapping and one allowlisted host, each with tests. That is deliberate friction.
- The mappings are string patterns, so a site redesign breaks them. They fail closed: no match means the old behavior, and a fetch failure means "history unavailable".
- A landing URL with no version depends on the official record being readable. When it is not, the user pastes a version URL.
- Sites that block honest clients stay unsupported. We accept that.
- The User-Agent exposes the tool's name, version and repository to the sites it calls. That is the point.

## Rejected alternatives

- **Fetching congress.gov.** It blocks automated clients. Getting past that would mean spoofing a browser, which we will not do. GovInfo has the same data officially.
- **LegiScan or Open States APIs.** They need keys. That breaks the keyless, localhost-first setup, and it adds a third party between the user and the official record.
- **Generic link-following on any site.** It would reopen the risk §5.1 closes: a hostile page could point our fetcher at any host. An allowlist keeps the reachable set small and reviewable.
- **Spoofing a browser User-Agent.** It is dishonest, and it hides who is calling from the sites' operators. Ohio did not need it.
