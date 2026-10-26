# 0013: Agent access

**Status:** accepted (2026-10-26). The decision came from issue #205; the prototype is #206 (PR #239).

## Context

Lawglass is useful to people, and the user wants it to be useful to software agents too. Two questions come first: which interface an agent should use, and why an agent would use Lawglass instead of reading the pasted URL itself.

The options studied were:

- an MCP server;
- a `--json` mode on the CLI;
- the existing local HTTP API;
- a Claude skill or plugin that wraps the CLI.

The case for Lawglass over a plain paste is what it adds: struck and inserted text read correctly, citations to section, page and line that are validated, and the cached, bounded pipeline. For a short, clean bill that case is weak: in an informal first comparison during the #205 study, pasting the bill tied. We expect it to be stronger for bills too big to read whole, scanned local measures, and redlines where repealed text must stay out of "current law", but that is a hypothesis to measure. It has not been tested against the strongest paste setup (the API with page images, citations and caching).

## Decision

1. **MCP over stdio is the agent path.** It shares one result schema with the CLI `--json` output of `search` and `get-section`. The HTTP API stays for the web UI only.
2. **A thin prototype, built as a measurement harness, not as a product.** `lawglass mcp` exposes four tools: `lawglass_ingest_document` (asynchronous and idempotent, with progress, open-world so clients ask the user first), `lawglass_outline`, `lawglass_search` and `lawglass_get_section` (views `current` and `redline`). The tools make no model calls and need no keys: the local backend only.
3. **Held behind measurement:** a "Who decides later" tool, a model-free "What changes", and a claim checker (only once its false-"supported" rate is 2% or lower). `ask` stays out.
4. **A pre-registered gate before any claim.** At least 10 documents across 5 classes, at least 40 blind-graded questions, at least 15 of them sensitive to struck text. The paths compared:
   - a plain fetch of the URL;
   - the API with PDF input, citations and caching;
   - an agent with the Lawglass tools;
   - Lawglass `ask`.

   Lawglass claims a class of document only if the agent with its tools beats the API path on accuracy, or ties at a third of the cost or less, and makes no struck-as-current error. The README makes no claim until then.

Whatever the interface, two constraints are already decided elsewhere and bind it:

- It goes through the budgets in core ([ADR 0012](0012-security-posture.md)), so an agent cannot run up the provider bill.
- Model output and document text stay untrusted. A tool that returns document text must label it as data.

## How the prototype honours those constraints

- **Untrusted text is wrapped.** Document text comes back inside a per-response wrapper tag labelled as data. Struck and inserted words carry markers with a per-response id, so text inside the bill cannot forge them.
- **Citation fields leak nothing.** The `cite`, `section` and `ref` fields are checked against strict shapes (bill designators, section-number grammar, short enumerators). A part that fails gets an opaque handle such as `s4`, so the document's own words never appear outside the wrapper.
- **Unknown is never reported as current law.** When change marks could not be read (an OCR'd scan page, or a New York or New Jersey bill whose bracket legend was not found), passages report `status: "unknown"` with a fixed warning, never `unchanged`.
- **Ingest is bounded.** Ingest is queued, takes the core `ingest` permit and has an hourly cap. Only refusals that happen before any download, and cancels while still queued, are refunded.

## Consequences

- `@modelcontextprotocol/sdk` is a runtime dependency, pinned exactly. It adds about 90 transitive packages that the stdio server does not use.
- Cross-process store safety (#222) and the asynchronous ingest work (#221) matter more now, because an agent client and a person's CLI can share one store.
- The measurement run is the next step for agent access. Until it passes, the MCP server is documented as a prototype.
