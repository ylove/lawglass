# 0002: Multiple LLM providers

## Context

The spec Amendments replace the original Anthropic-only scope.
Users bring their own keys and may need compatible local or hosted endpoints.
CI needs deterministic answers without external calls.

## Decision

Define one `LlmProvider` port with `anthropic`, `openai`, `google`, `claude-cli`, and `mock` adapters.
Use the official SDKs for Anthropic, OpenAI, and Google.
The OpenAI adapter accepts `baseURL` for OpenRouter, Ollama, Groq, and LM Studio.
The mock adapter is deterministic and used in CI.
Embeddings remain in the retrieval backends and never use the LLM provider.

## Consequences

Answer generation can change provider without changing retrieval.
Provider model names and capabilities need explicit configuration and validation.
Keys are sent only to their own provider; compatible endpoints use the configured destination.
