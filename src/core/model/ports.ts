/**
 * Ports: the two seams where implementations are swapped.
 *
 * - `RetrievalBackend`: where chunks are embedded, stored, searched and reranked.
 *   Adapters: `pinecone` (integrated inference + hosted rerank) and `local` (on-device
 *   embeddings, BM25, cross-encoder). Embedding happens *inside* the backend, so callers only
 *   ever pass text.
 * - `LlmProvider`: text generation and structured extraction.
 *   Adapters: `anthropic`, `openai` (+ any OpenAI-compatible baseURL), `google`, `claude-cli`, `mock`.
 *
 * Both have shared contract-test suites in ./contract-tests/ that every adapter must pass.
 */
import type { z } from 'zod';
import type { Chunk, ChunkFilter, StoredChunk } from './chunk.js';

// ---------------------------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------------------------

export type BackendKind = 'pinecone' | 'local';

/** Which index a single search hits. Hybrid modes are composed by core/retrieve, not backends. */
export type SearchIndex = 'dense' | 'sparse';

/** Metered usage, reported per operation so the CLI/eval can show cost. Zero when not applicable. */
export interface BackendUsage {
  /** Tokens embedded (Pinecone integrated inference, or local model tokens for parity). */
  embedTokens: number;
  /** Rerank units/requests (Pinecone bills per request; local reports documents scored). */
  rerankUnits: number;
  /** Pinecone read/write units when reported; 0 for local. */
  readUnits: number;
  writeUnits: number;
}

export const ZERO_USAGE: BackendUsage = {
  embedTokens: 0,
  rerankUnits: 0,
  readUnits: 0,
  writeUnits: 0,
};

export function addUsage(a: BackendUsage, b: BackendUsage): BackendUsage {
  return {
    embedTokens: a.embedTokens + b.embedTokens,
    rerankUnits: a.rerankUnits + b.rerankUnits,
    readUnits: a.readUnits + b.readUnits,
    writeUnits: a.writeUnits + b.writeUnits,
  };
}

export interface SearchHit {
  chunk: StoredChunk;
  /** Backend-native score; only comparable within one result list. */
  score: number;
}

export interface SearchRequest {
  docId: string;
  index: SearchIndex;
  query: string;
  topK: number;
  filter?: ChunkFilter | undefined;
  signal?: AbortSignal | undefined;
}

export interface RerankRequest {
  query: string;
  hits: readonly SearchHit[];
  topN: number;
  signal?: AbortSignal | undefined;
}

export interface UpsertProgress {
  done: number;
  total: number;
}

export interface RetrievalBackend {
  readonly kind: BackendKind;
  /** Create indexes / load models if needed. Idempotent. */
  ensureReady(signal?: AbortSignal): Promise<void>;
  /** True if this document's namespace already exists (re-ingest must then be a no-op). */
  hasDocument(docId: string): Promise<boolean>;
  /** Embed and store chunks in both the dense and sparse indexes, under the docId namespace. */
  upsertChunks(
    docId: string,
    chunks: readonly Chunk[],
    onProgress?: (p: UpsertProgress) => void,
  ): Promise<{ usage: BackendUsage }>;
  search(
    req: SearchRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }>;
  /** Fetch chunks by id (definition injection, citation lookup). Missing ids are omitted. */
  getChunks(docId: string, ids: readonly string[]): Promise<StoredChunk[]>;
  rerank(
    req: RerankRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }>;
  /** Remove the document's namespace from both indexes. Idempotent. */
  deleteDocument(docId: string): Promise<void>;
}

/** Retrieval modes compared by the eval harness (spec §5.6). */
export type RetrievalMode = 'dense' | 'sparse' | 'hybrid' | 'hybrid_rerank';
export const RETRIEVAL_MODES: readonly RetrievalMode[] = [
  'dense',
  'sparse',
  'hybrid',
  'hybrid_rerank',
];

/** How dense and sparse result lists are merged in hybrid modes. */
export type FusionMethod = 'rrf' | 'weighted';

// ---------------------------------------------------------------------------------------------
// LLM
// ---------------------------------------------------------------------------------------------

export type ProviderId =
  'anthropic' | 'openai' | 'google' | 'claude-cli' | 'mock';

export interface ProviderConfig {
  provider: ProviderId;
  model: string;
  /** Never logged. Absent for `claude-cli` and `mock`. */
  apiKey?: string | undefined;
  /** OpenAI-compatible endpoints (OpenRouter, Ollama, Groq, LM Studio, ...). */
  baseURL?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface LlmUsage {
  /** All input tokens, including any read from or written to a prompt cache. */
  inputTokens: number;
  outputTokens: number;
  /** Of `inputTokens`, how many were read from the provider's prompt cache (when reported). */
  cacheReadTokens?: number | undefined;
  /** Of `inputTokens`, how many were written to the provider's prompt cache (when reported). */
  cacheWriteTokens?: number | undefined;
}

/**
 * One piece of a message. `cache: true` marks the end of a prefix that repeats across requests
 * (the system rules plus a whole bill), so a provider that supports explicit prompt caching can
 * reuse it. Providers without explicit caching join the parts in order.
 */
export interface LlmTextPart {
  text: string;
  cache?: boolean | undefined;
}

export interface LlmMessage {
  role: 'user' | 'assistant';
  /** A plain string, or ordered parts when part of the message is a cacheable prefix. */
  content: string | readonly LlmTextPart[];
}

/** The text of a message, with any parts joined in order. */
export function messageText(content: LlmMessage['content']): string {
  return typeof content === 'string'
    ? content
    : content.map((part) => part.text).join('');
}

export interface TextRequest {
  system: string;
  messages: readonly LlmMessage[];
  maxTokens: number;
  temperature?: number | undefined;
  /**
   * How much reasoning to spend, for providers that support it (Anthropic `effort`). Absent:
   * the provider default. Others ignore it.
   */
  effort?: 'low' | 'medium' | 'high' | undefined;
  signal?: AbortSignal | undefined;
}

export type LlmStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'done'; usage: LlmUsage; stopReason: string | null };

export interface ObjectRequest<T> {
  system: string;
  /** A plain string, or ordered parts when part of the prompt is a cacheable prefix (v1.1). */
  prompt: string | readonly LlmTextPart[];
  schema: z.ZodType<T>;
  /** Short name for the schema (used by providers that need a tool/function name). */
  schemaName: string;
  maxTokens: number;
  /** Reasoning-effort hint, as on `TextRequest`. */
  effort?: 'low' | 'medium' | 'high' | undefined;
  signal?: AbortSignal | undefined;
}

export interface LlmProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** Stream text. Must end with exactly one `done` event, or throw an AppError. */
  streamText(req: TextRequest): AsyncIterable<LlmStreamEvent>;
  /** Return an object validated against `schema`, or throw AppError('PROVIDER_BAD_OUTPUT'). */
  generateObject<T>(
    req: ObjectRequest<T>,
  ): Promise<{ object: T; usage: LlmUsage }>;
}
