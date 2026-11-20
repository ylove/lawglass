# 0018: Hosting hooks for a separate paid product

**Status:** accepted (2026-11-09), issue #383. Part A (auth, read access, presentation seams, pinning, packaging), part B (quotes, admission, usage, budgets, model routing, SPA seams) and part C (settlement, spend gate, read-only requests) are implemented.

## Context

Lawglass 2.0 adds a self-serve hosted product at lawglass.xyz. It has sign-up, prepaid balances, a price for each bill, and account management. The owner decided that sign-up, billing and accounts are not part of the open-source product. They live in a separate private package that runs this server.

Today the private package couldn't plug in cleanly. `createApp` has no seams for any of these:

- outside authentication
- a per-request identity
- deciding whether paid work may start
- attributing usage to a reader
- routing a job to a different model
- refusing a document the reader hasn't unlocked

It is also hard to reach from outside. The only hosted gate is one shared access key. Routes added after `createApp` returns are unreachable behind its 404 and SPA fallbacks. The package has no `exports` and no type declarations, and importing `dist/cli.js` runs the CLI.

## Decision

The open-source server gains generic hooks. With none passed, behaviour is unchanged. None of them knows about money, accounts or a payment provider. They speak in terms of readers, jobs, estimates and usage.

1. **External auth.** `auth: { middleware, readerId(c) }` replaces the shared-key session gate and the reader-list cookie.
   - The middleware runs where the session check runs today. Its decisions are final for `/api/*`.
   - `readerId(c)` names whose document list a request uses (decision 0016). With external auth this is the signed-in account, not a cookie.
   - External auth implies the hosted feature set (`privateMode` features, not public mode). It cannot be combined with `--private` or `--public`.
2. **Read access.** `canRead(c, docId)` is checked on every `/api/docs/:docId/*` route before any other work. A refusal is a 404, so it never reveals that a document exists.
3. **Admission.** `admission(c, job)` is called before any request that would start paid model work for the reader. That covers ingest of a new or reused document, a question or chip, locate, a subject scenario and a section example. It returns one of:
   - `allow`, optionally with a budget;
   - `quote`, which becomes HTTP 402 with an opaque quote object the SPA shows and resubmits;
   - `deny`, carrying a status and an `ErrorPayload`.

   The job carries:
   - its kind;
   - the document id, when there is one;
   - the reader's `quoteId`, when one was sent;
   - an estimate from `src/core/cost`, computed before any model call.

   Background generation of a document (summary, breakdown, pictures, pre-drawn examples) is not admitted call by call. Each reader is admitted once, at ingest. The first ingest's budget becomes the document's generation budget.

4. **Quotes.** `POST /api/quote {url}` fetches and parses only. It makes no model call and stores nothing. It returns size facts and an estimate per configured model. A hosted package turns that into a price; the open-source server never shows one. Ingest accepts an optional `quoteId` and passes it to `admission`.
5. **Usage.** `onUsage(event)` receives every model call's usage. Each event names the feature, the model and the token split, including cache reads and writes, plus the job context. The job context is carried through `AsyncLocalStorage` from the route that started the work. Background work started by an admitted ingest keeps that ingest's context.
6. **Budgets.** A job budget, in tokens or in dollars against the cost table, is enforced in `Limits.meter()`.
   - Before each call, a job whose spend has reached its budget is refused with `BUDGET_EXHAUSTED`. That stops a single job at its ceiling, overshooting by at most one call per sequential job. Concurrent calls within a job may each overshoot by one.
   - The breakdown and examples stop cleanly, and the parts already written stay.
7. **Model routing.** `modelFor(job, c)` may choose the answer and extract models for a document. Cache keys already include the model, so two tiers of the same bill never share cached text. `runtime.providerFor(role, model)` builds a provider for an explicit model.
8. **Presentation seams.**
   - `csp` adds sources to the Content-Security-Policy directives. Nothing is ever removed, and `'unsafe-inline'` is refused.
   - `site` replaces the landing page and the quickstart.
   - `head` adds same-origin script or link tags to the SPA's `index.html`.
   - The SPA dispatches `lawglass:event` `CustomEvent`s for key reader actions. Each event carries a name and a few non-identifying fields, never bill text or the reader's question. This repository never sends them anywhere.
   - The SPA shows a quote dialog on a 402, and an account link when `/api/config` names one.
9. **Eviction.** `pinned(docId)` lets the host protect documents from eviction, for example documents a reader has paid for.
10. **Packaging.** `package.json` gains `exports` for `./server` (side-effect free), plus emitted `.d.ts` files. A `./web` export waits until a host needs to rebuild the SPA; for now a host serves the built `dist/web` and extends it through `head`. `createRuntime`, the security headers and the site pages are exported.

## Amendment (part B): generation scopes

A generation scope (budget, models, job id) is kept per (document, tier), where the tier is what `modelFor(job, c)` resolves for the reader. A reader at tier B never gets tier A's text or job; tiers do not share a scope or a cache.

The scope is, in order: the live in-memory one; else the host's `backgroundScope(docId, tier, models)` (cached for a minute); else, at ingest only, the scope of the newly admitted ingest. Ingest asks the hook before installing its own scope, so a re-ingest after a restart cannot take over a persisted scope. `createApp` throws when `admission` is set without `backgroundScope`, so a host that charges money cannot run unbudgeted generation by omission. If the hook returns `undefined` or fails, the document runs under a zero budget: no paid call, cached results still served. The hook must return the REMAINING budget, since a restored scope counts from zero. Without both hooks the requester stands in, as before.

Failed or abandoned paid calls are charged: a billed but unusable reply carries its usage on the `AppError`, and an abandoned stream is charged what the provider reported (Anthropic) or a conservative estimate flagged `estimated`. A budget-stopped breakdown or picture run is not cached as final.

Admission's fetch and parse hold an ingest slot, write nothing to the fetch cache, are rate limited per reader, and hand the download and parsed document to the ingest, which reads those bytes (see the 2026-11-16 note below).

## Amendment (part B): warnings for hosts

`modelFor` is called with the request context `c` and must take the tier from the reader's entitlement held on the server, never from request data the reader controls (a query string, a header, the body): otherwise a reader can run in, and read, a tier someone else paid for. It is also called on every generating GET (summary, breakdown, pictures, example) with a stand-in job `{kind: 'ingest', docId, estimate, estimates}` that has no `quoteId`, `serverQuote` or `tier`, so a host that decides the tier from the confirmed quote must also resolve it from the reader's entitlement, or those GETs fall to the default tier and fail closed. When a reader confirms a host `quoteId`, the host must check that `job.docId` and the estimates still match what it quoted: the server reads the bytes it measured for that reader and address, so the `docId` seen at admission is the one the confirm is read with (see the 2026-11-16 note below).

A host also must return the REMAINING budget from `backgroundScope`, and should use base64url quote ids (`[A-Za-z0-9_-]`, up to 128): the SPA refuses to confirm any other id with a plain message. A new admission for a (document, tier) whose scope is spent replaces the scope's budget, job id and reader and restarts stopped work; written breakdown parts and pictures are kept until a finished run replaces them.

## Amendment (part B): notes for hosts, round 3

`docComplete` on an ingest admission means the text, the pictures and the pre-drawn examples exist for the reader's tier. A host may then charge nothing, or only for the cached read, but must never allow without a budget.

`topUp` changes the job id and reader of a live scope in place, so calls already in flight when a new admission lands are reported under the new job. A scope restored from `backgroundScope` that is already spent takes the new admission's budget the same way. Only timeouts and aborts are charged an estimate when a provider gives no usage; a refused connection or an HTTP error never reached the provider.

## Part C: settlement, spend gate, read-only requests

A host that holds funds at admission cannot tie a charge to an outcome with parts A and B alone, and cannot stop spending in the middle of a run or serve guests safely. Part C adds three optional hooks. With none passed, nothing changes.

**Settlement.** `Admission`'s allow result may carry an opaque `ref` (1 to 128 characters of `A-Za-z0-9_-`). An invalid `ref` fails the request with a 500 before any work, and the job is not admitted. The `ref` is carried in the job context, so it is on every `UsageEvent.job`, and it comes back in `AppOptions.onJobEnd({job, ref, outcome, error?})`.

`onJobEnd` is called exactly once for each job the host admitted, whichever way it ends. A guard shared by every route that can end a job enforces this: the first end wins, so a late finish after a disconnect, or a failure after a delivered answer, is never reported twice.

| Job              | `ok`                                                                                            | `failed`                                                                                                   | `aborted`                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| ingest           | the document is registered                                                                      | any error, a changed source, a wrapper page (nothing registered), a closed spend gate, the ingest deadline | the reader disconnected first                                                        |
| question, chip   | the answer is delivered, a decline included (the optional scenario that follows does not count) | any error                                                                                                  | the reader disconnected first                                                        |
| locate, scenario | a result is produced                                                                            | any error; for a scenario also an attempt that could not be made or failed (it still answers `none`)       | the reader disconnected                                                              |
| example          | the example is stored (a validated "no honest example" is stored too)                           | any error, including a budget stop or a closed gate                                                        | the example was already running when the admitted job began, so this job did nothing |

`JobEnd.delivered` says what the reader actually received: `full` with `ok`, `partial` when any answer text or frames were streamed before an abort or failure, `none` otherwise. A reader can stream most of an answer and close the connection just before its end, so "capture on ok, release on the rest" would give those answers away. **Recommended policy:** capture (the fixed price, or the actual usage summed from `onUsage` by `ref`) when `outcome` is `ok` or `delivered` is not `none`; release only when `delivered` is `none`.

For an ingest that ends `ok`, `granted` is `used` when the admission's budget was put to work and `unused` when no generation remained to do for the reader's tier (everything was already cached), so a host can refund an unused grant.

**Settling an ingest and installing its grant is one synchronous step.** The host's saved scope (`backgroundScope`) is asked while the admitted ingest is handled, before the ingest starts and before the job can end; a saved scope that is invalid fails the ingest there (`failed`, `delivered: 'none'`, no work). When the document is registered the server calls `onJobEnd` with `ok` and, in the same tick with no `await` between them, installs the grant: it is added to the live (document, tier) scope if there is one, otherwise the pre-resolved saved scope plus the grant (or a new scope) is installed. If the exactly-once guard was already lost (the reader left, or the job failed, before registration finished) the job ended `aborted` or `failed`, nothing is installed, and the host releases an admission whose grant is never spent. A reader who leaves after registration cannot turn the job into `aborted`. On the reused-document path the job settles only after the document has been read and its history saved, so a disk error there fails it with no grant. A grant reported `granted: 'unused'` (everything already exists) is not added to any scope, so the host may refund it. `granted` is taken from the `docComplete` the admission already computed.

A new admission for a (document, tier) whose live scope still has budget **adds** its budget to the live one (a spent scope is replaced, as before). Later calls are reported under the new job and `ref`, and stopped work goes on. A call already in flight when the top-up lands is reported under the `ref` that was current when it started. A grant is never silently dropped.

**`backgroundScope` must return the remaining budget EXCLUDING the admission being handled.** After a restart the server adds the new admission's grant to the restored scope itself. Because the lookup happens before the job ends, a host that credits its ledger on `onJobEnd(ok)` is never consulted after its own credit; a host must NOT credit the grant at admission time (it would be counted twice). A generating request that is waiting on the same lookup cannot take the grant: whichever installs first, the ingest's grant is added to the scope that is live.

**Grant epochs.** A scope is stamped with the epoch it was resolved in, before any wait on the host. Every grant (a new scope, an added budget, a top-up) bumps a per-(document, tier) epoch. A stop mark or cool-down remembers the epoch its run started in; one from an older epoch is ignored, so a refusal that lands just after someone paid (another reader's request that found no budget) never makes the payer wait out a cool-down.

**Units.** Budgets in the same unit are summed. When a grant is in another unit than the live scope's (tokens against dollars), both are converted to dollars at the scope's model prices (the dearer of the input and output rate), so a dollars grant is never capped by an old token limit; with no price for the model the grant replaces the old ceiling.

A call already in flight when a grant lands is reported under the `ref` it started with, but its spend is charged to the scope when it finishes, so after a top-up (which resets the spend) one overshoot call of the previous payer counts against the new budget.

A subject scenario whose model attempt failed (an outage, a closed gate, a spent budget) answers `none` but is not cached, so the next request retries and settles by its own outcome. Only a genuine "no scenario" from the model is cached.

A host can then hold at admission, capture on `ok` or any delivery, and release on `failed` or `aborted` with `delivered: 'none'`. Usage is charged separately, call by call, through `onUsage`, so a failed job that spent tokens still shows them. Exempt work (a metadata chip), refused admissions and servers without an `admission` hook produce no `onJobEnd`. Background generation is never a job of its own: it runs under the ingest's scope and its `ref`.

A process that dies mid-job ends it without a callback. **Hosts must expire holds.** A graceful shutdown closes connections, which ends streamed jobs as `aborted`; an example drawing in the background is not tied to a connection and is not reported if the process exits first.

**Spend gate.** `AppOptions.spendGate?: () => boolean` is synchronous, so the host keeps its state in memory and updates it from `onUsage`. `Limits.meter()` checks it before every provider call, background included (and `paced` before it queues). Anything but `true`, or a throw, is closed. A closed gate refuses the call with `BUDGET_EXHAUSTED`, with `details.reason: 'spend_gate'`, and costs nothing. Background work stops as for a budget stop: it keeps what it wrote and reports `stoppedReason: 'spend_gate'` (`progress.stoppedReason` on the breakdown, and `stoppedReason` when the run is shown as stopped). Unlike a spent budget, a gate stop has no cool-down. The next request that would generate (a breakdown look, a summary look, an example, the pictures) goes on as soon as the gate reopens, from the parts already written. The gate does not check the budget, and the budget does not check the gate: a top-up never reopens a closed gate.

**Read-only requests.** `AppOptions.readOnly?: (c) => boolean | Promise<boolean>` is asked once per `/api/*` request. When it returns `true` the server serves cached results only and never starts or resumes generation for any source (summary, breakdown, pictures, examples). Per route:

- ingest, ask (every kind of chip as well) and quote are refused with 403;
- scenario, locate and locate/versions answer `disabled`, as in public mode;
- the summary, breakdown, pictures and example GETs return a cached result or `disabled`, and do not wait for runs in progress;
- `/api/config` turns off free-form questions, scenarios and locate.

A read-only request runs in a scope with a zero budget on the reader's own tier (so cached results are found under the right model), which is defence in depth: even a bug that reached for a model would be refused. The hook never has a chance to fail open: a hook that throws, or returns anything but `false`, makes the request read-only. Hosts use it for signed-out guests on featured bills.

**Shared stop marks.** A tier with budget does not wait out another tier's budget stop on a breakdown or pictures run the tiers share; only a stop on its own tier cools down.

**Quotes name exact bytes.** `QuoteFacts` gains `contentHash`, the SHA-256 that ingest uses as the document id, so a host can bind a quote to the bytes it measured.

**Top-ups are per tier.** A new admission for one (document, tier) clears failure cool-downs and stop marks only for that tier's summary, breakdown, example and picture runs. Another tier's marks stay.

**Note, 2026-11-16 (#407): the ingest reads the admitted bytes.** The first design compared the admission fetch with a second download made by the ingest. That cannot work for sources whose bytes change on every request (New York): the hashes never match, and a host that binds its quote to `job.docId` then sends a fresh 402 forever. The server now keeps, per reader and address, the latest download that reader was priced on (bytes, parsed document, history), and the ingest reads exactly that, so the quote prices what is read. The key is the reader and address, not our `quoteId`, because a host confirms with its own quote id. An entry is not removed on use (a 402 then a confirm, or a retry, must see the same bytes); an admission that uses it renews its 30-minute age. Bounds: 50 entries; per reader, 3 entries and a quarter of the byte budget, so one reader's downloads evict only that reader's own (when the parse would not fit the share, only the raw bytes are kept, counted at their size, and the next admission parses them again; the result must price the same as the quote, or the ingest stops with `PAYMENT_REQUIRED`. Raw bytes over the share are not kept: such a source, if its bytes also change on every download, cannot be admitted by a host that binds its quote to the docId, because each confirm measures again and sees a new docId); and a 64 MiB total counting the raw bytes plus the parsed document (text at 2 bytes a character, plus about 100 bytes for each span and reference). The parse-time DOM is dropped, and `safeFetch`'s `commitCache` no longer holds it, which a test checks with the real fetcher and the garbage collector. When no entry exists the bill is measured again and stored before the host's admission runs. A quote of ours, if presented, must match the measure in facts and estimates or the ingest stops with `PAYMENT_REQUIRED`. A host should still check that `job.docId` matches its quote: after an eviction or expiry the bill is measured again and its `docId` can differ. The `docId` is unchanged.

**Amendment (2026-11-19, #429): answer modes, output caps and a question quote.** A question that reads the whole bill can cost far more than a focused (retrieval) answer, and a host that charges per question wants the reader asked first. The server gives it generic parts and no pricing:

- **Mode.** The ask request takes an optional `mode`: `auto` (default, today's rule), `whole` (the whole bill when it fits the whole-bill budget, else as `auto`) or `focused` (retrieved excerpts even when the bill would fit). Chips ignore it: a chip's read is part of what the chip is. `AskRequest.mode` and `ClientConfig.questionQuote` were added by contract change #431. The response reports what ran in the existing `answer.context` (`whole` or `excerpts`) and the retrieval event's `mode`.
- **Admission.** A typed question's `AdmissionJob` carries `mode` (the read forecast from the document: `whole` or `focused`), `requestedMode` (what the reader sent, `auto` when absent, so a host can tell a confirmed whole read from an unconfirmed `auto`), and an `estimate` that follows that read and the caps. The admitted `mode` is the read that runs: `focused` forces excerpts, and `whole` may only fall back to them. `JobEnd.ran` says which read actually ran, so a host can refund a `whole`-admitted question that fell back.
- **Caps.** `AppOptions.answerLimits: { wholeMaxTokens?, focusedMaxTokens? }`, default 16,000 and 8,192 (unchanged). Caps are whole numbers from 2,048 to 64,000 and unknown keys are refused. A cap includes thinking, so a cap below the default also lowers the model's reasoning effort (`low` under 6,000, at most `medium` below the default) so a short answer still fits. Estimates and `questionQuote` worst cases use the same caps.
- **Quote.** `AppOptions.questionQuote?: (request, c) => Promise<{ whole?: { units }, focused: { units }, remaining?, unit? } | undefined>`, behind `POST /api/docs/:docId/question-quote`. The request carries `docId`, `reader`, `tier` and `worstCase` (from the exported pure `questionCeiling`, the high bound per mode). Units are opaque. Without a hook the endpoint answers `{ quote: null }`.
- **Web.** With `ClientConfig.questionQuote` true, the UI asks the endpoint before a typed question. Only when `whole.units > focused.units` does it show the choice (focused answer first, then the whole read, each with its units, and cancel); otherwise it asks directly as before. If the quote request fails it sends `mode: 'focused'`, never `auto`. Without the flag it never calls the endpoint.
- **Bound.** `questionCeiling` is a high bound: it counts the optional story calls, sizes focused input at the most an excerpt prompt can hold, and sizes a forced-focused change question on an amended bill that fits whole.

**Amendment (2026-11-20, #435): a per-call gate and call ends.** The zero-parameter `spendGate` cannot hard-cap spend: it has no job or call identity, and the budget is charged after a call, so parallel calls, retries and late stories overshoot. A separate option, `callGate(call) => boolean | Promise<boolean>`, is added; `spendGate` is unchanged. If both are set, both apply.

- **Gate.** The call is `{ ref, jobKind, docId, callId, model, worstCaseUsd }`, asked and awaited before EVERY billed provider attempt, at the metering seam every feature uses (answers, chips, stories, locate, summary, breakdown, pictures, examples, metadata, each parallel call). A provider that makes several HTTP requests for one call (OpenAI's plainer-format and `stream_options` fallbacks) gates each request after the first separately, with its own `callId`: the earlier attempt ends unreported and usage is attributed to the last. The Google adapter turns off the SDK's automatic function calling and automatic continuation, so one call is one request. Every billed hosted-Pinecone request (embedding writes, queries, reranks, fetches, namespace deletes and index stats, including each 429 retry) is gated the same way, through the same gate lifecycle (an approval that arrives after the request was abandoned is ended unreported and nothing is sent) (`jobKind` of the job they run in; the model is the index or rerank model). Anything but `true`, or a throw or rejection, refuses the call with the same `BUDGET_EXHAUSTED` / `spend_gate` stop a closed kill switch makes.
- **Attempts.** Each attempt carries the complete context it began under (reference, ids), so a top-up between attempts never mixes references in usage or call ends. Only a dispatched attempt can be charged an estimate; a retry whose gate wait was cancelled is not. Only per-call gating takes a rate admission for a retry; without `callGate` the rate accounting is as before.
- **Timing.** The wait for the gate ends when the reader leaves or after `Limits` `gateTimeoutMs` (30 s), so a silent gate holds no concurrency slot; that is a refusal. A gate that approves after the wait ended gets one `onCallEnd` with `reported: false` and no provider call. After the gate answers, the budget and any zero-argument `spendGate` are checked again right before the provider is touched.
- **`worstCaseUsd`.** An upper bound. Input: the UTF-8 bytes of everything sent, one token per byte (no tokenizer emits more tokens than bytes), plus fixed framing (1,024 per request, 32 per message, 16 per part); a structured-output schema counts twice, since adapters send it twice. Priced at the dearer of the ordinary and cache-write input rates, with the long-context premium when the prompt is long enough, plus `maxTokens` at the output rate, from the cost tables. `Infinity` for a model with no price, for input that is not text, and for the claude-cli provider (a local subprocess with no output limit). For a Pinecone request it is always `Infinity` (Pinecone bills in read and write units and per rerank request, which no rate bounds): a host that gates Pinecone applies its own policy to those calls, which carry the index model name. The server does not serialize calls; a host reserves `worstCaseUsd` inside the gate and settles on usage or the call end.
- **Usage.** `UsageEvent.callId` is the same id.
- **Call end.** `onCallEnd({ callId, reported, jobKind, ref?, docId? })` fires once for each call that was let through, after its usage event: `reported: false` means no usage was delivered (it failed before billing, a superseded attempt, the reader left while the gate was deciding, a backend request, or the provider could not say), so a host can release the reservation. Refused calls get no end. A call aborted while the gate was deciding never reaches the provider.

## Consequences

- The open-source server stays complete on its own. Local mode, `--private` and `--public` are unchanged, and every hook is optional with a no-op default.
- A host that misuses a hook can open the server to its readers. One example is an `auth.middleware` that lets everyone through. The hooks are documented as security-relevant, and the private package carries its own tests and review.
- The estimate is advisory. Only the job budget actually stops spending, and it bounds overshoot to one call per job. Hosts must price with that margin.
- The paid product is versioned separately but tracks this server's major version.
