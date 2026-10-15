# LLM provider adapters

`src/core/llm/index.ts` exports `createProvider(config: ProviderConfig)` and
`defaultModel(provider, purpose)`. The frozen ports remain in `src/core/model/`.
Callers resolve their keys and select an answer or extraction model before
constructing the provider. An empty model string selects the answer default.
Embeddings remain the retrieval backend's responsibility.

```ts
import { createProvider, defaultModel } from '../core/llm/index.js';

const provider = createProvider({
  provider: 'anthropic',
  model: defaultModel('anthropic', 'extract'),
  apiKey: resolvedKey,
});
```

| Provider   | Answer default    | Extraction default    | Output strategy                                                                        |
| ---------- | ----------------- | --------------------- | -------------------------------------------------------------------------------------- |
| anthropic  | claude-sonnet-5-5 | claude-haiku-5-5      | Messages streaming; native JSON schema                                                 |
| openai     | gpt-6.1-sol       | gpt-6-luna            | Chat Completions; JSON schema → JSON object → prompted JSON                            |
| google     | gemini-3.8-flash  | gemini-3.5-flash-lite | Content streaming; response JSON schema                                                |
| claude-cli | claude-sonnet-5-5 | claude-haiku-5-5      | Local print-mode stream JSON; prompted JSON                                            |
| mock       | deterministic     | deterministic         | Word streaming; overlapping excerpts with section citations; conservative empty values |

Defaults were checked on 2026-10-13 against the [OpenAI model catalog](https://developers.openai.com/api/docs/models)
and [Gemini model catalog](https://ai.google.dev/gemini-api/docs/models). Anthropic
names follow the spec. Explicit model overrides are supported for every provider.

OpenAI accepts `config.baseURL`, then `OPENAI_BASE_URL`, for compatible endpoints.
Provider keys travel only over `https:` or to `localhost`, `127.0.0.1` or `[::1]`.
On loopback a missing key is replaced by a non-secret `local` placeholder. A plain
`http:` endpoint elsewhere (Ollama or LM Studio on a LAN) also receives only that
placeholder, even when a key is configured and even when none is, so a key never
crosses the network in cleartext; set `<PREFIX>_ALLOW_INSECURE_KEY=1` to send the
configured key anyway. `https:` endpoints require their own configured key. Keys are not inferred from another provider's environment.
The JSON-format fallback runs only after a format-specific rejection, never after
an authentication, rate-limit, network or validation failure. All successful
structured results are validated with the caller's zod schema.

Successful text streams finish with exactly one `done`. Failed or interrupted
streams throw an `AppError`; they do not emit a success event. Usage includes
cached Anthropic input and Google thinking output when reported; unavailable
usage is zero. The default request timeout is 120 seconds and covers stream
consumption as well as request startup. SDK diagnostic logging is disabled;
errors discard upstream messages, causes and request bodies.

## Local Claude CLI

`claude-cli` is opt-in and is never chosen automatically, even when `claude` is on
`PATH`. Provider selection order: an explicit provider (environment, config file
or flag), then the first available API key in the order anthropic, openai,
google, then (on a TTY) a single question asking which of those three to use,
followed by that provider's key. With no provider, the tool fails with
`MISSING_KEY` listing the options. Select it explicitly with
`<PREFIX>_LLM_PROVIDER=claude-cli` for local development. It uses the user's installed
`claude` executable and leaves authentication to that executable. The adapter
never reads credential files or forwards `ProviderConfig.apiKey` to it. There is
no application login flow. The CLI API has no hard output-token flag; its own
output limits apply, while the adapter enforces timeout, abort and one turn.

Every invocation uses a fresh temporary cwd containing only a private system
prompt file. `--system-prompt-file` replaces Claude Code's default system prompt;
the conversation messages stay on stdin. The child receives only basic process
settings (`PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`, `LANG`, `LC_*`,
`TERM`) and the user's `CLAUDE_*` / `ANTHROPIC_*` environment configuration,
except `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN`, which are withheld so the CLI
bills the user's Claude login; `<PREFIX>_CLAUDE_CLI_USE_API_KEY=1` opts in. The model
name must match `^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$` so it cannot be read as a flag.
Other providers' keys and application settings are excluded. The adapter
disables built-in tools (`--tools ""`) and all inherited MCP servers
(`--strict-mcp-config --mcp-config '{"mcpServers":{}}'`). It also uses safe mode,
empty setting sources, disabled slash commands and no session persistence to
prevent hooks, skills or project customizations from running. Each flag is
explained beside the spawn call. No permission-bypass flag is used. Abort or
timeout kills the child with SIGKILL; normal, failed and abandoned requests
remove their temporary directory. Real execution is rejected in CI.

## Verification

`npm run check` runs contract suites for all five adapters without outbound
network access. Official SDK parsers consume small HTTP response recordings via
injected fetchers. CLI tests replay an allowlisted real local transcript through
an injected spawn. [Asset provenance](../tests/llm/assets/README.md) distinguishes
the synthetic HTTP protocol recordings from the real CLI recording.

`npm run test:live` separately runs the API provider contracts only when
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY` / `GOOGLE_API_KEY` exists.
This opt-in command makes live calls and spends tokens. It never runs the Claude
CLI. The standard unit test projects keep their outbound-network guards intact.
