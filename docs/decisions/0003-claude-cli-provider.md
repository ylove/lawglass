# 0003: An opt-in Claude CLI provider

## Context

The spec Amendments allow a local development adapter for the user's installed Claude CLI.
Anthropic's terms do not allow third-party apps to offer claude.ai login.
API keys are the advertised path, following [Anthropic's developer guidance](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account#developers).

## Decision

Offer `claude-cli` only as an explicit opt-in for local development.
Invoke the user's installed `claude -p`; the CLI manages its own authentication.
Never read, store, forward, or otherwise handle Claude CLI credentials.
Never offer a claude.ai login or subscription credential flow in this app.

## Consequences

Local developers can select this adapter without this app handling credentials.
Production and public workflows use the advertised official API-key providers.
CLI availability and behavior remain a local development concern.
