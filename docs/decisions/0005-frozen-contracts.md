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
