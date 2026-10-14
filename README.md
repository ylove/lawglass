# legislation-summary (working title)

> Paste a link to any bill. Get a plain-language answer to "what does this say, and how does it affect me?", with every claim cited to the exact section, page, and line.

**Status:** pre-release, under active development toward a localhost release candidate. The final product name is being chosen; this repository will be renamed.

## What it will do (RC)

- Ingest one legislation URL (XML, HTML, PDF with a text layer, or plain text) from a federal, state, county, or municipal source.
- Structure-aware chunking that understands sections, definitions, cross-references, and amendment markup (struck vs. inserted text).
- Hybrid retrieval (dense + sparse + rerank) on Pinecone, plus a built-in local backend that needs no account.
- Answers that cite every claim, written for a ~7th-grade reading level, from the bill's own text only.
- An `npx` CLI and a local web UI.
- A retrieval eval harness, with results published in this README.

Not legal advice. Answers are generated only from the text of the document.

## Development

Use Node.js 22.13 or newer (or Node.js 24); `.nvmrc` selects the latest 22.
The scaffold was installed with npm 11.12.1. The lockfile pins dependencies.
TypeScript 6.0.3 stays within typescript-eslint's supported range; tsdown is
still below 1.0, so Node builds use tsup. An esbuild override pins the patched
transitive release while tsup's dependency range catches up.

```sh
npm ci
npm run check
npm run build
node dist/cli.js --help
```

`check` runs strict typed ESLint, both Node and web typechecks, and tests with
75% global coverage thresholds. Node tests block outbound HTTP with a mock dispatcher;
only `127.0.0.1` and `localhost` may connect. Web tests use happy-dom.
Run a subset with `npm test -- <pattern>`. Use `npm run format` to apply Prettier
and `npm run format:check` to verify formatting.

The `package-smoke` and `e2e` CI jobs exercise a freshly installed npm tarball
with the built-in local backend and mock LLM provider. They generate their PDF
from `tests/synth`, isolate configuration under a temporary HOME, and reuse the
model cache keyed on `models.lock.json`. No real legislation or API keys are needed.
For local runs, download models once with `npm run models:fetch`, then run:

```sh
npm run smoke:package
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" npm run test:e2e
```

Both commands build and pack automatically. Chromium runs with zero retries and
retains a trace on failure in `test-results/`; CI uploads those traces. Browser
tests live in `e2e/` and are excluded from the fast Vitest `check` suite. CI
installs Chromium with `--with-deps` on Linux.

For unattended setup, `init --non-interactive --backend local` saves validated
environment settings in the private config file without terminal prompts. It
preserves existing settings and follows the same `--force` permission checks as
interactive `init`.

See [Eval run details](docs/eval.md) for per-question retrieval JSON and the offline
`eval compare` command, which shows where modes gain or lose relevant top-five hits.

The CLI accepts a local PDF, XML, HTML, or text file as well as an HTTP(S) URL:

```sh
node dist/cli.js ingest ./bill.pdf
node dist/cli.js ingest "./downloaded bill.xml" --name my-bill
node dist/cli.js ./bill.txt
```

`file://` URLs work too. Formats are detected from the bytes, with the extension
as a fallback. Local files use the filename as their default label and have the
same 50 MiB limit as downloads. Re-ingesting unchanged bytes spends no tokens;
editing a file creates a new document, with a suffix if its filename label is
already taken. File ingestion is CLI-only; HTTP ingest must remain HTTP(S)-only.

To preview the built web UI, run `npx vite preview --outDir ../../dist/web`. The
Vite root is `src/web`, so `--outDir` must be given relative to it.

Builds produce `dist/cli.js`, an empty server entrypoint at `dist/server.js`,
and the React shell at `dist/web/`. CLI commands currently print their follow-up
issue number and exit with code 2. The local retrieval backend is implemented;
CLI ingestion, retrieval orchestration, LLM, and server wiring are still pending.
The UI displays the working name and disclaimer only.

## Local retrieval backend

`LocalBackend` in `src/core/index/local/` implements the frozen `RetrievalBackend`
port. It needs no Docker or account. Its constructor accepts `configDir` (defaults
to the brand's directory under your home directory), a separate `root` for the
document store, and injectable `Embedder`, `Reranker`, and download `logger`.

Each document lives under `<config dir>/store/<docId>/` with `chunks.jsonl`,
`dense.f32`, `bm25.json`, and `meta.json`. Dense rows are normalized 384-dimensional
Float32 vectors, stored in little-endian row order. Metadata records model
identities, revisions, dimensions, counts, and file hashes. Writes stage complete
directories, rename temporary files, and publish metadata last. Replacement uses
a recoverable backup; operations on a namespace are serialized across backend
instances in the same process. Separate processes must not write the same store
concurrently.

Dense search uses quantized BGE with CLS pooling and its query instruction.
Sparse search uses explicit BM25 (`k1=1.2`, `b=0.75`), with IDF per document,
including exact statute numbers and normalized dollar amounts. Reranking scores
query/document pairs with a quantized MiniLM cross-encoder. Embedding usage counts
the tokenizer's actual non-padding tokens, including instructions and special
tokens, after model truncation; rerank usage counts documents scored. An unchanged
embedding text reuses its vector. A changed embedding model requires removing
and re-ingesting an existing document.

Models are lazily imported and downloaded from the immutable Hugging Face
revisions in `models.lock.json`. The first download prints a single message
(about 59 MB for both models). Preload them and run the offline integration suite:

```sh
npm run models:fetch
npm run test:models
```

The fetch script accepts `--config-dir` and the brand's `CONFIG_DIR` environment
variable. For an isolated development cache:

```sh
export LEGSUM_CONFIG_DIR="$PWD/.cache/local-backend"
npm run models:fetch
npm run test:models
```

`test:models` sets `LOCAL_MODELS=1`, disables remote models, and loads the exact
cached revision directories. It runs the shared backend contract plus a dense
appropriation paraphrase check and a cross-encoder relevance check under the
existing network guard. It is excluded from `npm run check`, which uses fake
models. `.github/workflows/local-models.yml` caches the pinned models and runs
the offline suite on Node 22 and 24.

issue number and exit with code 2. No ingestion, retrieval or server features
are implemented yet. The UI displays the working name and disclaimer only.

The [LLM provider adapters](docs/llm-providers.md) implement streaming and validated
structured output for Anthropic, OpenAI-compatible endpoints, Gemini, an opt-in
local Claude CLI, and a deterministic mock. They are available to core callers;
CLI command integration is still pending. Unit tests use offline HTTP/subprocess
replays. Run `npm run test:live` separately for key-gated API contract tests.

The [product spec](docs/spec.md) is the source of truth; its Amendments take
precedence. [Decision records](docs/decisions/) explain the backend, provider,
Claude CLI, and Node version choices, and how struck and underlined text is read
from PDF geometry. Shared contracts are reserved for a separate
contract-change issue. Product identity belongs in `src/core/brand.ts`.

## License

[MIT](LICENSE)
