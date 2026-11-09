# 0018: Hosting hooks for a separate paid product

**Status:** accepted (2026-11-09), issue #383. Part A (auth, read access, presentation seams, pinning, packaging) and part B (quotes, admission, usage, budgets, model routing, SPA seams) are implemented.

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

Admission's fetch and parse hold an ingest slot, write nothing to the fetch cache, are rate limited per reader, and hand the parsed document to the ingest; an ingest that fetches different bytes stops so the reader is quoted again.

## Amendment (part B): warnings for hosts

`modelFor` is called with the request context `c` and must take the tier from the reader's entitlement held on the server, never from request data the reader controls (a query string, a header, the body): otherwise a reader can run in, and read, a tier someone else paid for. It is also called on every generating GET (summary, breakdown, pictures, example) with a stand-in job `{kind: 'ingest', docId, estimate, estimates}` that has no `quoteId`, `serverQuote` or `tier`, so a host that decides the tier from the confirmed quote must also resolve it from the reader's entitlement, or those GETs fall to the default tier and fail closed. When a reader confirms a host `quoteId`, the host must check that `job.docId` and the estimates still match what it quoted: the server only compares the admission fetch with the ingest fetch, and the source can change between the 402 and the confirm.

A host also must return the REMAINING budget from `backgroundScope`, and should use base64url quote ids (`[A-Za-z0-9_-]`, up to 128): the SPA refuses to confirm any other id with a plain message. A new admission for a (document, tier) whose scope is spent replaces the scope's budget, job id and reader and restarts stopped work; written breakdown parts and pictures are kept until a finished run replaces them.

## Consequences

- The open-source server stays complete on its own. Local mode, `--private` and `--public` are unchanged, and every hook is optional with a no-op default.
- A host that misuses a hook can open the server to its readers. One example is an `auth.middleware` that lets everyone through. The hooks are documented as security-relevant, and the private package carries its own tests and review.
- The estimate is advisory. Only the job budget actually stops spending, and it bounds overshoot to one call per job. Hosts must price with that margin.
- The paid product is versioned separately but tracks this server's major version.
