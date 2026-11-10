# Bill cost estimates

`billFacts(sections, options)` uses only parsed sections. It counts live text with the same
characters/4 heuristic as the whole-bill policy, and reuses `chooseMapUnits`,
`chooseBreakdownUnits`, and `classifyBill`. `breakdownUnitCap` is the server's
`breakdownMaxUnits` value (a count, `'all'` or `Infinity`) and defaults to 30. A cap above 30
is full coverage (#382): every substantive part is a candidate, so the map selector's 60-part
cut no longer applies. Pass the cap the server will run with. This does not change frozen
model contracts.

`estimateBill(facts, plan, prices)` assigns answer/extract model IDs in `plan`, enables
features by default, and quotes up to eight examples (`exampleCount` is configurable).
Each feature has `low` and `high` call, token and dollar estimates. Total input includes cache
reads/writes, matching `LlmUsage`; subtract those categories to get ordinary billed input.
USD is calculated **per call** before summing, so Haiku's 100,000-token threshold counts the
entire prompt and applies to that call's output too. The separate question estimate is not
included in the bill total. It approximates questions, model-backed chips and locate; their
exact output budgets differ. Empty/metadata-only chips may cost nothing.

Low assumes successful first passes with short visible output. High assumes every malformed
retry and reading-level rewrite and spends the full output budgets, including adaptive thinking.
`thinkingTokensPerCall: { low, high }` specifies additional billable thinking within each
answer call's existing output limit. Low adds its allowance to the visible forecast; high
already reserves the full output limit, so increasing its thinking allowance cannot exceed that
limit. Default zero is an explicit uncalibrated assumption. Use usage events to calibrate it.

The default cache policy `reuse` charges an initial write per feature and reads on later calls
in the **low** bound, assuming a five-minute cache lifetime. The **high** bound never counts on a
cache hit: background batches can run further apart than the cache lasts, so every cached prefix
is priced as a write. Contexts are multiplied by a prompt markup (1.1 low, 1.25 high) for the
escaped `<part>` tags, ids and page/line markers that chars/4 does not see (measured at about
1.16 on a 380K-character bill), so long-context pricing tiers apply when the real prompt crosses
them. Use `cold` to charge a write on every call, or `none`
for providers without prompt caching. Summary scenarios and examples currently send their
context uncached. Summary and breakdown picture jobs batch separately and send generated
item text, not the bill. Their item counts are forecasts from map/brief counts, because a
parse-only estimator cannot know which generated items will pass the picture eligibility check.

These are planning ranges, not guaranteed provider billing limits: tokenization, prompt/schema
framing (1,000–3,000 tokens per call), metadata already present in markup, generation lengths,
optional scenarios, reference/definition context, and cache eligibility can change actual usage.
Near the whole-bill threshold the runtime scans indexed chunks and may select a different mode.
Costs grow with added substantive units within a fixed strategy; crossing into omnibus
classification disables the summary scenario, and switching context strategies can reduce cost.
Embeddings, reranking, infrastructure, taxes and provider discounts are excluded.

The CLI reads `answerModel`, `extractModel`, and optional `costPrices` from the existing
configuration. A price override replaces the complete rate card for that model, in USD per
million tokens:

```json
{
  "costPrices": {
    "custom-model": {
      "input": 2,
      "output": 10,
      "cacheRead": 0.2,
      "cacheWrite": 2.5,
      "longContext": {
        "aboveInputTokens": 100000,
        "input": 4,
        "output": 20,
        "cacheRead": 0.4,
        "cacheWrite": 5
      }
    }
  }
}
```

Unknown model IDs fail explicitly until a rate card is configured. The built-in Sonnet cache
read price follows issue #381's $0.20/MTok; the source currently lists $0.10, recorded as a TODO
in `prices.ts`. Opus's $0.20 cache read rate is confirmed by that source.

Inject a `UsageSink` with `new Limits({ ...limitsConfig, usageSink })`. `meter(provider, feature)`
and `paced(provider, { feature })` report one event for each returned object or terminal stream
usage event, including cache splits. Calls rejected before reaching a model emit nothing.
Sink failures do not retry paid model work. Provider failures that return no usage (including
malformed output rejected inside an adapter) cannot be measured at this seam; no usage is
invented for them. The no-op default needs no setup. Job/document attribution is left to #383.
Registry-local cache fields default to zero when reading older entries and are accumulated
alongside existing totals. No files under `src/core/model/` are changed.
