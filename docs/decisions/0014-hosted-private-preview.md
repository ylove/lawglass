# 0014: Hosted private preview on Cloud Run

**Status:** accepted (2026-10-21), issues #247 and #250

## Context

Lawglass needs a hosted demo at lawglass.xyz that works with any federal bill a reviewer pastes in. There is no hosting budget, and the demo is for a few invited people, not the public.

The server was built for one long-running process on one machine:

- all state lives in files under `~/.lawglass`, with lock files and strict permission checks;
- the summary is generated in the background after the response is sent;
- an ingest runs inside one long event stream;
- rate limits and caches live in process memory;
- the local retrieval models need the native ONNX runtime.

Serverless functions (Vercel's, for example) keep no files between requests, stop work once a response is sent and cap bundle size. Running Lawglass there would mean rewriting the storage layer. A container platform runs the same process unchanged.

## Decision

1. **Cloud Run, one instance.** The service runs in `us-east1` with `maxScale: 1` and `minScale: 0`. One instance keeps the single-process assumptions true. Scaling to zero keeps an idle preview at no cost, within the free tier.
2. **Request-based billing.** CPU is allocated only while a request is open. Visitors without an invite are answered in milliseconds, so they cost almost nothing. Background summary generation would stall between requests, so `GET /api/docs/:id/summary` waits up to 20 seconds while a summary is being written, keeping a request open during the work.
3. **Invite-only access: `serve --private`.** The full app (free-form questions, scenarios, live summaries) is open to anyone holding the access key, read from `LAWGLASS_ACCESS_KEY`. The first request with `?k=<key>` sets a 30-day `Secure` session cookie holding an HMAC of the key, then redirects to a URL without it. Everyone else sees a static page with the product name and an invite note. Anonymous public use still waits for the public-mode work in ADR 0012 (#180).
4. **Federal and Ohio only.** In hosted modes, ingest accepts only federal (congress.gov, govinfo.gov) and Ohio legislature hosts (`LAWGLASS_INGEST_HOSTS` overrides the list). Other states' bills ingest through the generic parsers, but New Jersey, for one, marks deletions with brackets that the parsers do not read. Those bills would show repealed text as current law, so they get a plain "not yet" message instead.
5. **Local backend, models in the image.** The embedding and reranking models are pinned in `models.lock.json` and baked into the image, so there is no Pinecone key in the cloud and no download at startup.
6. **State in a tarball, not a network filesystem.** The app keeps working on the instance's own filesystem. An entrypoint script restores `~/.lawglass` from a tarball in a private Cloud Storage bucket at boot. It saves a new tarball when the state has changed and gone quiet, and again on shutdown. Mounting the bucket as the live directory would put the registry's lock files and permission checks on a filesystem without POSIX locking.
7. **Secrets in Secret Manager.** The Anthropic key and the access key reach the container only as environment variables at runtime. The image, the repository and CI never see them. The service account can read those two secrets and write one bucket, nothing else.
8. **Builds from committed files only.** `deploy/cloud-run/deploy.sh` builds from `git archive` of a tag, so nothing local can enter the image.

## Consequences

- **Cold starts.** The first visit after about 15 idle minutes waits for a cold start, roughly 5 to 15 seconds.
- **Lost work on a crash.** A crash loses changes made since the last save. A clean shutdown loses none.
- **Single-instance capacity.** The preview's capacity is one instance with 2 vCPUs and 4 GiB. That is enough for a handful of concurrent readers; the core budgets (ADR 0012, item 6) keep it from being overrun.
- **Access key in platform logs.** Cloud Run's own request log records the `?k=` URL inside the operator's project. The app's log never records query strings.
- **Preview-grade domain mapping.** The custom domain uses Cloud Run domain mapping, which Google labels as preview and not recommended for production because of latency. It costs nothing. The `run.app` address is the fallback. A load balancer can replace it later at a monthly cost.
- **Deploy files name the config directory.** They use `.lawglass` directly, so a product rename must update `deploy/` too.
