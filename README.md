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

## License

[MIT](LICENSE)
