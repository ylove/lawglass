# 0008: Answer cache on disk

**Status:** accepted (2026-10-14), issue #118

## Context

rc.2 runs the plain-language summary automatically when a document opens. Without a cache, every visit would pay for an LLM call, and two tabs opened together would pay twice. In public mode (spec §7) it would let anonymous visitors spend the host's money.

## Decision

- **Key.** `docId`, chip, provider, model and prompt version. `docId` is the hash of the document's bytes, so changed text is a different document. Provider and model are in the key because a different model gives a different answer. The prompt version is in the key so that editing a prompt cannot serve stale output.
- **Storage.** Files under the config directory, mode 0600, like the raw-bytes cache. Answers come from a document and may be sensitive to the user.
- **Eviction.** An entry is removed with its document (`remove`, and LRU eviction under the document cap). Nothing outlives the document it describes.
- **Invalidation.** Bumping the prompt version changes every key, so old entries are never read again. They are swept when their document is evicted or on the next cache cleanup.
- **De-duplication.** Concurrent requests for one key share one in-flight call, and all of them get its result.
- **Failures are not cached.** An error, a refusal or an answer that failed citation validation is never stored.
- **Public mode is cache-only.** It serves a hit and never starts generation for an anonymous visitor. On a miss it shows the instant purpose clause or title, with no summary.

## Consequences

- A document's summary is paid for once per provider, model and prompt version.
- Opening a document twice, or from two tabs, costs one call.
- Changing a prompt makes the next open pay once more. That is the intent.
- A hosted deployment must warm the cache itself, since visitors cannot.
- Cached answers sit on disk, so they follow the same 0600 rule as keys and raw bytes.
