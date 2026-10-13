These small assets replay provider wire formats without network access or credentials.

`claude-cli.jsonl` is a real local recording made on 2026-10-13 with the prompt
`Reply with only: Hello.` and the same tools-disabled flags used by the adapter.
It retains only text events and token counts. Account, session/message IDs, cwd,
initialization details, diagnostics and billing fields were removed with an allowlist.

The HTTP JSON/SSE assets are synthetic protocol recordings based on the official
SDK formats. They exercise the real SDK HTTP parsers through injected fetchers;
they are not claimed to be captured live responses. Live contracts are separate
and key-gated (`npm run test:live`). No bill fixtures or request bodies are recorded.
