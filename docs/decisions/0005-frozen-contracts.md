# 0005: Frozen shared contracts

**Status:** accepted (2026-10-13), issue #9

## Context

The RC is built by several agents working in parallel, each in its own branch: parsers, backends, LLM providers, the server and the web UI. If each one defined its own version of "a section", "a chunk" or "an SSE event", the merges would collide and the seams would drift.

## Decision

- **One frozen contract module.** All shared shapes live in `src/core/model/`, as zod schemas and TypeScript types. Feature code imports them from `src/core/model/index.ts`:
  - `NormalizedDoc`, `Section`, `Span`, `Chunk` and `ChunkFilter`;
  - the `RetrievalBackend` and `LlmProvider` ports;
  - the API and SSE events;
  - the eval schemas;
  - `AppError`.
- **Embedding happens inside the backend.** Callers pass only text. That lets the Pinecone adapter use integrated inference while the local adapter runs models on-device behind the same port.
- **Metadata filters are typed (`ChunkFilter`).** Raw Pinecone filter syntax never leaks outside its adapter.
- **Citations work at section level.** Answers cite `[S:<sectionId>]`, and the UI resolves a citation to the section's spans from the cached `NormalizedDoc`. Struck and inserted styling therefore never has to fit in vector metadata.
- **Every adapter must pass a shared contract suite.** The suites live in `tests/contracts/`: `describeBackendContract` and `describeProviderContract`. The in-memory and scripted test doubles there prove the suites themselves are sound.

## Consequences

- Parallel tracks can build and unit-test against the doubles before the real adapters exist.
- A change to anything exported from `src/core/model/` needs a `contract-change` issue and a review by the orchestrator. Feature PRs must not edit these files.

## Amendment 2026-10-14 (#117)

The rc.2 round grew the contracts. Every change is additive and every new field is optional, so RC-era registries, doc stores and answers still parse (pinned by `src/core/model/rc2.test.ts`).

- **`doc.ts`:** `SponsorLink`, `SponsorProfile` and `BillMetadata.sponsorProfiles?`. Profiles come only from official records, never from the model, so the metadata extraction schema deliberately omits them. Links must be `https:`, and a `search` link can never be `verified`.
- **`history.ts` (new):** `BillHistory` (official summary, versions, actions, amendments, sources). Rule: name a person or committee only when the official record does.
- **`scenario.ts` (new):** `Scenario` with closed `AvatarId` and `IconId` enums, so the model picks ids and can never emit SVG or HTML. A `computed` figure must carry its `expr`, `illustrative` is always `true`, and a scenario has 3 to 4 frames.
- **`answer.ts` / `api.ts`:** `AnswerResult.scenario?`, an `AskEvent` `scenario` variant, `DocDetail.history?` and `DocDetail.preview?`, `SummaryResponse` (for a future `GET /api/docs/:id/summary`), and the `history` `ChipId`.
- **`history` chip is not served yet.** It is in the enum so #128 needs no second contract change, but the served chip list stays at 8 and `getChip('history')` refuses until #128 lands. The web client ignores `scenario` events until #131.
