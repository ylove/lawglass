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

## Amendment 2026-10-14 (#199)

The rc.3 round grows the contracts again. Every change is additive and every new field is optional (except the response-only `ClientConfig.scenariosEnabled`), so rc.2 registries, doc stores and answers still parse (pinned by `src/core/model/rc3.test.ts`).

- **`answer.ts`:** `ChipId` gains `delegations` and `ChipStrategy` gains `extract`. Enum only. The chip is not served yet (#202 serves it): the served list stays at 8 chips, `getChip('delegations')` refuses, and `runChip` throws for the `extract` strategy.
- **`doc.ts`:** `BillMetadata.docKind?` (`DocKind`) and `BillMetadata.amends?` (`AmendsTarget`: name, optional jurisdiction, sections). `ExternalRef.kind` is unchanged so an rc.2 binary sharing `~/.lawglass` still parses; charter refs use `kind: 'other'` plus the new optional `category` (`charter | local_code | general_law`). `NormalizedDoc.scan?` (`ScanStatus`: per-page `read | uncertain | not-read`).
- **`api.ts`:** `DocDetail.scan?` and `DocDetail.scenarioPersonas?`, `ClientConfig.scenariosEnabled` (required) and `ClientConfig.turnstileSiteKey?` (for #180), and `ScenarioRequest` / `ScenarioResponse` for `POST /api/docs/:docId/scenario`, reusing `Scenario`.
- **Not touched:** `Span`, `ChunkType`, `ERROR_CODES`, `DocSummary` / `RegistryEntry` (strict), `ConfigSettings` (strict).

## Amendment 2026-10-26 (#272)

The v1.1 round (milestone M13) grows the contracts once, up front, so its parallel tracks share one set of shapes. Every change is additive, and every new field is optional or has a default. v1.0 documents, answers and configs still parse (pinned by `src/core/model/v11.test.ts`).

- **`ports.ts`:**
  - `LlmMessage.content` may be ordered `LlmTextPart`s. A part with `cache: true` ends a prefix that repeats across requests (the rules plus a whole bill). Anthropic maps it to `cache_control`; the other providers join the parts (`messageText`).
  - `TextRequest.effort` is a reasoning-effort hint.
  - `LlmUsage` reports cache reads and writes when the provider does.
- **`answer.ts`:**
  - `AnswerResult.context` (`whole` or `excerpts`) records what the model read.
  - `simplified` marks a reading-level rewrite.
  - `usage` keeps the cache counts.
- **`doc.ts`:**
  - `ReferenceText` is another law's text, read from an official source and cited as `[S:ref:…]`. The reserved `ref:` prefix means a reference can never collide with a bill section id.
  - `NormalizedDoc.references` holds them, and `ExternalRef.referenceId` points at the one that was read.
- **`api.ts`:**
  - `ClientConfig.library` (`local` or `reader`).
  - `ClientConfig.examples` (at most 6).
  - `ClientConfig.breakdownEnabled`, default off.
  - `SectionExcerpt.reference`, for the drawer.
  - `ScenarioResponse` gains `pending` and a `note`, for per-section examples.
  - `SectionBrief` and `BreakdownResponse`, for "Section by section" (`GET /api/docs/:docId/breakdown`).
