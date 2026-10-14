# 0012: Security posture

**Status:** accepted (2026-10-14), issues #87, #179, #180, #181

## Context

Lawglass fetches URLs, parses untrusted documents, sends text to model providers and serves a local web UI. The main use is on one person's machine. A public mode exists to demonstrate a hosted design, and it is not deployed. An audit before rc.3 found gaps that the localhost-first design had left open: no Content-Security-Policy or other security headers, a Turnstile check that does nothing, a trusted-proxy setting that reads a client-controlled header, an unbounded rate limiter, and request limits that live only in the HTTP layer.

## Threat model

- **The user is trusted. The document is not.** Legislation text, PDFs and web pages can carry markup, prompt-injection text and hostile structure.
- **Other web pages in the user's browser are not trusted.** A page the user visits can try to call the local server. DNS rebinding and cross-site requests are the usual routes.
- **In public mode, visitors are anonymous and not trusted.** They can try to spend the host's model budget, exhaust memory, or reach internal addresses through the fetcher.
- **Model output is untrusted.** It is never used as markup, a URL to fetch, or a command.
- **Keys belong to the user.** They go only to their own provider and are never logged.
- **Out of scope for now:** a deployed cloud service, with its own network, secrets and identity concerns. That is a later round.

## Standards

We check our work against these, and cite them in issues and tests:

- **OWASP ASVS 5.0, Level 2**, for the web application and API.
- **OWASP Top 10 for LLM Applications 2025**, for prompt injection, output handling and unbounded consumption (LLM10).
- **CWE Top 25**, as a checklist of weakness classes to test against.
- **NIST SSDF** (SP 800-218), for how we build and release.
- **OpenSSF Scorecard**, for repository and supply-chain hygiene.

These are targets we review against, not certifications. We do not claim compliance.

## Decision

1. **Localhost-first.** The server binds to loopback by default. Whether a bind is local is decided by parsing the address (`ipaddr.js`), not by comparing host strings, so every loopback spelling, including IPv4-mapped IPv6, gets the Host and Origin checks (#87). A non-loopback bind needs an explicit opt-in.
2. **Security headers on every response** (#179). A strict Content-Security-Policy (`default-src 'self'`, no inline script or style, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`), `nosniff`, `Referrer-Policy: no-referrer`, same-origin opener and resource policies, and a restrictive `Permissions-Policy`. HSTS stays off on localhost. `Cache-Control: no-store` applies to every `/api/*` response, including streams. In public mode only, the CSP also admits Turnstile's origin.
3. **Public mode fails closed** (#180). Creating the app in public mode without a bot-check verifier throws. The CLI refuses `--public` without Turnstile configuration unless the operator passes `--no-bot-check` on purpose. The verifier checks success, hostname, action and token age, through an injected fetcher with a timeout. The secret is read from the environment only and never appears in logs or errors.
4. **Trusted proxy by hop count** (#180). `--trust-proxy <hops>` takes the client address that many positions from the right of `X-Forwarded-For`. The leftmost entry is client-controlled and is never used.
5. **Bounded state** (#180). The rate limiter is an LRU with a key cap and per-key pruning, grouping IPv6 clients by /64. Public mode serves the summary from the answer cache only. It strips query strings and fragments from source URLs it lists, and caps concurrent event streams per client and globally.
6. **Budgets live in core** (#181). Concurrency limits (2 for ingest, 4 for ask and scenario), a soft per-minute ceiling for model-backed calls, and the question length cap live in `src/core/pipeline/`. The CLI and any MCP or other non-HTTP caller pass through them, so a looping agent cannot run up the user's provider bill. The HTTP layer adds the public per-IP daily budget on top.
7. **Reporting.** Exploitable findings go through GitHub private security advisories, not public issues. A `SECURITY.md` that says so is part of the follow-up work.

## Consequences

- Security-critical code keeps the 90% line-coverage rule: fetch, citation validation, and now the header, verifier and budget modules.
- End-to-end tests fail on any CSP violation. Public-mode end-to-end tests use Cloudflare's documented test keys. Unit tests never touch the network.
- Existing public-mode tests change, since the no-op verifier is gone. Tests inject an allow-all verifier where they need one.
- Normal single-user behavior does not change. Limits are set above what one person reaches.
- This ADR describes the decided design. Each item is delivered by its issue, and the spec and README describe only what has shipped.
