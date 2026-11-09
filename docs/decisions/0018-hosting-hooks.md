# 0018: Hosting hooks for a separate paid product

**Status:** proposed (2026-11-09), issue #383

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
   - Before each call, a job whose spend has reached its budget is refused with `BUDGET_EXHAUSTED`. That stops a single job at its ceiling, overshooting by at most one call.
   - The breakdown and examples stop cleanly, and the parts already written stay.
7. **Model routing.** `modelFor(job)` may choose the answer and extract models for a document. Cache keys already include the model, so two tiers of the same bill never share cached text. `runtime.providerFor(role, model)` builds a provider for an explicit model.
8. **Presentation seams.**
   - `csp` adds sources to the Content-Security-Policy directives. Nothing is ever removed, and `'unsafe-inline'` is refused.
   - `site` replaces the landing page and the quickstart.
   - `head` adds same-origin script or link tags to the SPA's `index.html`.
   - The SPA dispatches `lawglass:event` `CustomEvent`s for key reader actions. Each event carries a name and a few non-identifying fields, never bill text or the reader's question. This repository never sends them anywhere.
   - The SPA shows a quote dialog on a 402, and an account link when `/api/config` names one.
9. **Eviction.** `pinned(docId)` lets the host protect documents from eviction, for example documents a reader has paid for.
10. **Packaging.** `package.json` gains `exports` for `./server` (side-effect free), plus emitted `.d.ts` files. A `./web` export waits until a host needs to rebuild the SPA; for now a host serves the built `dist/web` and extends it through `head`. `createRuntime`, the security headers and the site pages are exported.

## Consequences

- The open-source server stays complete on its own. Local mode, `--private` and `--public` are unchanged, and every hook is optional with a no-op default.
- A host that misuses a hook can open the server to its readers. One example is an `auth.middleware` that lets everyone through. The hooks are documented as security-relevant, and the private package carries its own tests and review.
- The estimate is advisory. Only the job budget actually stops spending, and it bounds overshoot to one call per job. Hosts must price with that margin.
- The paid product is versioned separately but tracks this server's major version.
