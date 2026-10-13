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

Use an up-to-date Node.js 22 release (or Node.js 24); `.nvmrc` selects 22.
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

Builds produce `dist/cli.js`, an empty server entrypoint at `dist/server.js`,
and the React shell at `dist/web/`. CLI commands currently print their follow-up
issue number and exit with code 2. No ingestion, retrieval, LLM, or server features
are implemented yet. The UI displays the working name and disclaimer only.

The [product spec](docs/spec.md) is the source of truth; its Amendments take
precedence. [Decision records](docs/decisions/) explain the backend, provider,
Claude CLI, and Node version choices. Shared contracts are reserved for a separate
contract-change issue. Product identity belongs in `src/core/brand.ts`.

## License

[MIT](LICENSE)
