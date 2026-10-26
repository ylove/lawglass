# Roadmap

This page lists work that is designed or wanted but not scheduled. Each item was a GitHub issue, closed when it moved here, so that the issue list only shows work in progress. To pick an item up, reopen its issue: the design notes and review history are still there.

Sizes: **M** is about a day, **L** is several days.

## Reading the bill

### Strike-through and underline from scanned page images ([#193](https://github.com/ylove/lawglass/issues/193)), L

Some city charter amendments and older bills are scans. Today Lawglass detects OCR'd scan pages and marks each one `read`, `uncertain` or `not-read`. Every scanned document warns that struck words may appear as current text (spec amendment 16).

The next step is to recover the marks themselves from the page image with deterministic pixel analysis, then feed them into the same rules that read vector PDFs.

- **Release gate:** struck-word precision of at least 0.95 and inserted-word precision of at least 0.90 on the labelled scans. Below that, the marks stay off.
- **Prerequisite:** none. The design is in the issue.

### Measure strike and insert reading span by span ([#147](https://github.com/ylove/lawglass/issues/147)), L

Nobody has measured how accurately Lawglass reads struck versus inserted text, span by span. Only one golden bill has struck text, and the leakage check matches words in answers rather than spans.

- **Work:** hand-label the struck and inserted spans of a few more Ohio bills with amendments, then report span precision and recall in the eval.
- **Why it matters:** both of the next two items build on this number.

### "Strata": the law as the bill would leave it ([#145](https://github.com/ylove/lawglass/issues/145)), L

This is a "law after" view. Each sentence is tagged as current law, added by the bill, or added in committee. Sentences the bill once had and lost are listed separately.

- **Prerequisite:** #147, plus sentence alignment across versions.

### A plain-language diff between two versions of a bill ([#130](https://github.com/ylove/lawglass/issues/130)), L

This compares two official versions, for example introduced and passed, using the before-and-after machinery of "What does it change?". A change is credited to an amendment only when a single adopted amendment covers that stage.

- **Prerequisite:** #147.

## Answers

### A sturdier signal for "is this question about what changed?" ([#104](https://github.com/ylove/lawglass/issues/104)), L

Detection uses a phrase list today, and a probe of 40 plain-language change questions found 65% recall.

- **Options:**
  - always retrieve struck text into a separate, labelled pool;
  - run a cheap intent check with the small model;
  - train a classifier.
- **Prerequisite:** a held-out set of citizen phrasings to measure against, and a stronger leakage eval for the first option.

### "How does this affect…?": examples on demand ([#198](https://github.com/ylove/lawglass/issues/198)), M to L

The server side exists: `POST /api/docs/:docId/scenario` and the suggested personas. Each part of a bill already has its own "Show an example" (spec amendment 23), which covers the common case.

- **Left to build:** a "How does this affect…?" strip with 3 to 5 suggested people and a "Someone else…" field, each result shown as its own example. See spec amendment 17.

### Warn when an answer mixes cited and uncited sentences ([#219](https://github.com/ylove/lawglass/issues/219)), M

Measured before building: a detector that flags a sentence without a citation, skipping lead-ins, disclaimers and limitation sentences, fired on 3 of 6 real cached answers and 9 of 21 injection-eval replies. The real flags were all overview sentences ("This bill sets defense policy and funding for fiscal year 2025.") before cited bullets. Exempting openers would reopen the hole the warning is for.

- **Next step:** cite overview sentences (prompt rule 2) and re-measure on 50 or more recorded live answers.

## Hosting and security

### Public mode, hardened ([#180](https://github.com/ylove/lawglass/issues/180)), L

The hosted preview runs in private mode: anyone without an invite link gets the public site, and the API needs a session. An open public mode, where anyone can use the app, needs more than that.

- **Already done:** trusted proxy hops, the ingest host allow-list and the model-call budgets.
- **Left:**
  - real Turnstile verification;
  - failing closed at startup;
  - a bounded, per-/64 rate limiter in place of the unbounded per-address map;
  - caps on open SSE streams;
  - a per-visitor daily budget;
  - a bounded library;
  - security event logging.
- **Required before:** any open public launch.

### Coordinate the local store across processes ([#222](https://github.com/ylove/lawglass/issues/222)), L

A `serve` process, a CLI command and an eval run can touch the same `~/.lawglass` at once. The registry already uses an owned lock (#252).

- **Left:** the local search store, the answer cache and eval cleanup need an interprocess lock or immutable generations.
- **When it matters:** only when two processes share one library. The hosted preview runs a single process.

## Research

### Competitors and the "why not paste the link into Claude?" baseline ([#204](https://github.com/ylove/lawglass/issues/204)), L

The first competitive scan is in the issue. The second run is the pre-registered evaluation in [decision 0013](decisions/0013-agent-access.md): Lawglass's tools against the same bills pasted into a model with citations and caching.

- **Rule until then:** make no claim about agent access.
