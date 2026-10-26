# 0015: Read the whole bill when it fits

**Status:** accepted (2026-10-26), issue #273

## Context

Thomson Reuters tried the hosted preview and saw answers such as “The excerpts don't show the definitions themselves” and “The excerpts don't show the full purposes of the pilot program or who counts as an eligible entity.” Every answer used top-K retrieval; even the on-arrival summary read only the outline and the opening chunk of each part. Missing context became a visible product limitation on bills small enough to read in full.

Most pasted bills fit comfortably in a modern context window. The enrolled GENIUS Act (S. 1582, 119th Congress) is about 33,000 tokens; S. 5687 (119th Congress) is about 5,500. The v1.1 contracts (#272) already support cacheable message parts, effort, cache usage and answer context modes.

## Decision

- A shared context policy sums stored chunk `tokenCount` for the text that would be shown. At or below 100,000 tokens, use `whole`; above it, use `excerpts`. The branded `WHOLE_BILL_MAX_TOKENS` environment variable overrides the budget; `0` forces excerpts. Deleted-only chunks are excluded except for change questions. Those questions count the deleted chunks too.
- Fetch all numbered chunks through `RetrievalBackend.getChunks`, using the existing consecutive per-section ID scheme. Restore section-tree and numeric chunk order explicitly; a relevance search cannot prove completeness. No shared contract change is needed.
- Whole mode uses the existing per-chunk citation attributes and validates against every supplied section, including merged section coverage. A nonexistent section is still removed. Change questions use the same trusted inline markers as excerpt mode, with the full marked section rather than an excerpt window. Struck text never becomes current law.
- The system rules are fixed across questions and chips. The first user-message part contains the document metadata and full bill and has `cache: true`. The second contains the trusted chip instruction, if any, and the escaped question. Chip instructions never enter the cached prefix.
- Whole-mode answers default to medium effort (`EFFORT=low|medium|high` overrides it) and 16,000 output tokens to leave room for thinking. Excerpts retain their 8,192-token default. Truncated answers remain flagged and are never answer-cached.
- Freeform and retrieval-strategy chips skip search in whole mode. The summary makes one whole-bill call. Definitions retain their existing first-25-and-count behavior, and the marked what-changes path remains unchanged. Unmarked amendment instructions use the whole bill without the subset-coverage note. Metadata chips still make no model call.
- Whole-mode automatic and requested scenarios may read every live chunk. Schema, citation and numeric grounding validation are unchanged. Structured scenario generation uses its existing object request; it does not get the answer's text-prefix cache marker.
- Extend ADR 0008's disk-cache identity with context mode and the whole-mode prompt version. Automatic summaries and the scenario route share the summary-key builder. Scenario cache versions also include context mode. Public summary requests remain cache-only.
- Both answer prompts tell the model never to discuss excerpts, passages, chunks or what it was shown. Whole mode describes the bill's full text and distinguishes an unanswered question from a partly answered one.
- Large bills retain retrieval and the existing summary map-reduce path. The retrieval and injection eval explicitly force excerpts mode.

## Consequences

At the issue's Sonnet 5.5 input rates ($2 per million tokens, $0.20 per million cached tokens), a 33,000-token bill costs about $0.066 (6.6 cents) for ordinary uncached input and $0.0066 (0.66 cents) for later cache reads. A 5,500-token bill costs about 1.1 cents uncached and 0.11 cents on a read. These figures exclude output, prompt overhead and any cache-write premium. A cache write is not a cache read, and cache expiry or a different prefix requires another write.

Full-bill input increases first-call prefill work and input cost relative to a handful of chunks. It removes search and rerank latency, and prefix reuse can reduce later prefill latency and cost. Backend chunk fetches still take time, including on a disk-cache lookup that needs to choose the context mode. Whole mode is a configured budget, not an automatic provider-window detector; an operator using a smaller-context model can lower or disable it.

The retrieval eval continues to measure candidate recall, ranking, definition injection and answer quality from bounded excerpts. It remains relevant for large bills and retrieval regressions; it does not measure whole-bill answer quality or demonstrate that a retriever found every provision of a small bill. Synthetic whole-mode tests separately check completeness, prompt caching boundaries, citations and amendment handling.
