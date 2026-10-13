# Agent guide

Conventions for any coding agent (Codex, Claude, others) working in this repo. Humans: see README.md.

## What this is

A localhost-first legislation RAG tool: an `npx` CLI plus a local web UI. You give it one legislation URL; it parses the document structure (including struck vs. inserted amendment text), indexes it with hybrid retrieval, and answers questions in plain language with citations to section, page and line. `docs/spec.md` is the source of truth. Its **Amendments** section overrides the rest. Decisions are in `docs/decisions/`.

## Commands

- `npm ci`: install exactly from the lockfile.
- `npm run check`: lint, typecheck and tests. **Run this before every commit you hand off; it must pass.**
- `npm run build`: build the CLI and server (to `dist/`) and the web UI (to `dist/web/`).
- `npm test -- <pattern>`: run a subset of tests.

## Rules

1. **Contracts are frozen.** Shared types and zod schemas live in `src/core/model/`. Do not change them in a feature PR. If you need a change, stop and say so; it needs its own `contract-change` issue.
2. **The product name lives only in `src/core/brand.ts`.** The name is not final. Use `BRAND.*` everywhere: CLI name, env-var prefix, config dir, index prefix, UI title. A lint rule enforces this.
3. **Never commit fixtures, secrets or `.env`.** Real legislation files are downloaded to the gitignored `fixtures/downloads/` by `scripts/fetch-fixtures.ts` and used only in local tests. Those tests skip when the files are absent. CI uses generated synthetic samples from `tests/synth/`.
4. **No network in unit tests.** The test setup blocks outbound connections. Inject fetchers, resolvers and SDK clients so tests can fake them.
5. **Never log API keys** or include them in errors. Keys only go to their own provider.
6. **Tests come with the code.** Every module ships with vitest tests next to it (`*.test.ts`). Security-critical modules (`core/fetch`, citation validation) need ≥90% line coverage.
7. **TypeScript strict, ESM, Node ≥ 22.** Prefer small pure functions and explicit types at module boundaries. Validate external data with zod. No `any` without a comment explaining why.
8. **Keep it readable.** This repo is also a portfolio piece. Name things clearly, comment the *why* and not the *what*, and keep retrieval and chip strategies explicit rather than clever.
9. **Dependencies.** Check the current version with `npm view <pkg> version` before adding a dependency, and prefer well-maintained packages. Don't add a dependency for something that takes a few lines.

## Git

- Work on the branch you were given; never commit to `main`.
- Use conventional commit messages (`feat(parse): ...`, `fix(fetch): ...`, `test: ...`, `chore: ...`, `docs: ...`), small and focused.
- End commit messages with a `Co-Authored-By:` trailer naming the agent, e.g. `Co-Authored-By: Codex <noreply@openai.com>`.
- Don't push, open PRs or edit GitHub issues unless told to; the orchestrator does that.

## GitHub text written by agents

Issue, PR and comment text written by an agent starts with `:robot: **<agent name>**`, e.g. `:robot: **Codex (implementer)**`. The orchestrator uses `:robot: **Orchestrator::**`.
