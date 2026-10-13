# 0001: Pinecone plus a built-in local backend

## Context

The spec Amendments replace the original Pinecone Local Docker proposal.
Pinecone Local reached end-of-life on 2026-10-07.
The localhost workflow must also work without an account or Docker.

## Decision

Keep two adapters behind one `RetrievalBackend` port: `pinecone` and `local`.
Pinecone uses the integrated-inference design in spec §5.5.
Local uses transformers.js dense embeddings, explicit BM25, and a local cross-encoder.
Choose Pinecone when a key resolves, otherwise local; `--backend` overrides that choice.
Remove the `PINECONE_HOST` override and Docker dependency.

## Consequences

Retrieval strategies stay explicit and share one application-facing contract.
Local usage requires model downloads and on-device resources, but no provider account.
Evaluation must report backend differences rather than assume equivalent rankings.
