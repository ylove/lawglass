import { join } from 'node:path';
import {
  AppError,
  Chunk,
  ZERO_USAGE,
  type BackendUsage,
  type ChunkFilter,
  type RetrievalBackend,
  type RerankRequest,
  type SearchHit,
  type SearchRequest,
  type StoredChunk,
  type UpsertProgress,
} from '../../model/index.js';
import { contextualText } from '../../chunk/index.js';
import { buildBm25, scoreBm25 } from './bm25.js';
import {
  createLocalModels,
  defaultConfigDir,
  throwIfAborted,
  type Embedder,
  type LocalModelOptions,
  type Reranker,
} from './models.js';
import { FileStore, type Snapshot } from './store.js';

export type { Embedder, Reranker } from './models.js';
export { createLocalModels } from './models.js';

export interface LocalBackendOptions extends LocalModelOptions {
  /** Store root (not the config directory), injectable independently of the model cache. */
  root?: string;
  embedder?: Embedder;
  reranker?: Reranker;
}

function stored(chunk: Chunk): StoredChunk {
  const { embedText: _omit, ...result } = chunk;
  return result;
}

export function matchesFilter(
  chunk: StoredChunk,
  filter?: ChunkFilter,
): boolean {
  return (
    !filter ||
    ((!filter.chunkType || filter.chunkType.includes(chunk.chunkType)) &&
      (!filter.amendmentStatus ||
        filter.amendmentStatus.includes(chunk.amendmentStatus)) &&
      (!filter.sectionIds || filter.sectionIds.includes(chunk.sectionId)) &&
      (!filter.definesTerm ||
        (chunk.definesTerm !== undefined &&
          filter.definesTerm.includes(chunk.definesTerm))))
  );
}

function limit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new AppError(
      'INVALID_INPUT',
      'Result limit must be a nonnegative integer.',
    );
}

function normalize(vector: Float32Array, dims: number): Float32Array {
  if (vector.length !== dims || vector.some((v) => !Number.isFinite(v))) {
    throw new AppError(
      'BACKEND_UNAVAILABLE',
      'Local embedder returned an invalid vector.',
    );
  }
  const length = Math.hypot(...vector);
  return vector.map((v) => (length ? v / length : 0));
}

const usage = (embedTokens = 0, rerankUnits = 0): BackendUsage => ({
  ...ZERO_USAGE,
  embedTokens,
  rerankUnits,
});

export class LocalBackend implements RetrievalBackend {
  readonly kind = 'local' as const;
  private readonly store: FileStore;
  private readonly embedder: Embedder;
  private readonly reranker: Reranker;
  private readonly disposeModels: () => Promise<void>;

  constructor(options: LocalBackendOptions = {}) {
    this.store = new FileStore(
      options.root ?? join(options.configDir ?? defaultConfigDir(), 'store'),
    );
    const models = createLocalModels(options);
    this.embedder = options.embedder ?? models.embedder;
    this.reranker = options.reranker ?? models.reranker;
    this.disposeModels = models.dispose;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    await this.store.ensureReady();
    await this.embedder.ensureReady(signal);
    await this.reranker.ensureReady(signal);
    throwIfAborted(signal);
  }

  /** Release ONNX sessions when a long-lived caller is finished with this backend. */
  dispose(): Promise<void> {
    return this.disposeModels();
  }

  hasDocument(docId: string): Promise<boolean> {
    return this.store.run(docId, () => this.store.has(docId));
  }

  private compatible(snapshot: Snapshot): void {
    if (
      snapshot.meta.dims !== this.embedder.dims ||
      snapshot.meta.embedding.id !== this.embedder.model.id ||
      snapshot.meta.embedding.revision !== this.embedder.model.revision
    ) {
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'This document uses a different embedding model. Remove it and ingest it again.',
      );
    }
  }

  upsertChunks(
    docId: string,
    input: readonly Chunk[],
    onProgress?: (progress: UpsertProgress) => void,
    signal?: AbortSignal,
  ): Promise<{ usage: BackendUsage }> {
    return this.store.run(docId, async () => {
      // The queue may have made this call wait behind another write; a client that left in
      // the meantime must not start an embedding run.
      throwIfAborted(signal);
      const incoming = input.map((chunk) => {
        const parsed = Chunk.safeParse(chunk);
        if (!parsed.success)
          throw new AppError(
            'INVALID_INPUT',
            'Invalid chunk supplied to the local backend.',
          );
        return parsed.data;
      });
      if (incoming.some((chunk) => chunk.docId !== docId))
        throw new AppError(
          'INVALID_INPUT',
          'Chunk namespace does not match document id.',
        );
      const previous = await this.store.load(docId);
      if (previous) this.compatible(previous);
      // Map insertion order is stable, so replacements keep their existing vector row.
      const previousChunksById = new Map(
        previous?.chunks.map((chunk) => [chunk.id, chunk]),
      );
      const chunksById = new Map(previousChunksById);
      const vectorsById = new Map(
        previous?.chunks.map((chunk, row) => [chunk.id, previous.vectors[row]]),
      );
      const changed = new Map<string, Chunk>();
      for (const chunk of incoming) {
        chunksById.set(chunk.id, chunk);
        const old = previousChunksById.get(chunk.id);
        if (old?.embedText !== chunk.embedText) changed.set(chunk.id, chunk);
        else changed.delete(chunk.id);
      }
      const result = changed.size
        ? await this.embedder.embed(
            [...changed.values()].map((chunk) => chunk.embedText),
            'document',
            signal,
          )
        : { vectors: [], tokens: 0 };
      if (
        result.vectors.length !== changed.size ||
        !Number.isSafeInteger(result.tokens) ||
        result.tokens < 0
      )
        throw new AppError(
          'BACKEND_UNAVAILABLE',
          'Local embedder returned invalid counts.',
        );
      [...changed.keys()].forEach((id, row) => {
        const vector = result.vectors[row];
        if (!vector)
          throw new AppError(
            'BACKEND_UNAVAILABLE',
            'Missing embedding vector.',
          );
        vectorsById.set(id, normalize(vector, this.embedder.dims));
      });
      // Nothing is on disk until save() publishes a complete generation (staged in a temporary
      // directory, then renamed), so cancelling here leaves the previous generation or nothing.
      throwIfAborted(signal);
      incoming.forEach((_chunk, i) =>
        onProgress?.({ done: i + 1, total: incoming.length }),
      );
      // Progress callbacks may be where the client was found gone; do not publish after that.
      throwIfAborted(signal);
      const chunks = [...chunksById.values()];
      if (
        !previous ||
        JSON.stringify(chunks) !== JSON.stringify(previous.chunks)
      ) {
        const vectors = chunks.map((chunk) => {
          const vector = vectorsById.get(chunk.id);
          if (!vector)
            throw new AppError(
              'BACKEND_UNAVAILABLE',
              'Missing embedding vector.',
            );
          return vector;
        });
        await this.store.save(docId, {
          chunks,
          vectors,
          bm25: buildBm25(chunks.map((chunk) => chunk.text)),
          meta: {
            version: 1,
            embedding: this.embedder.model,
            reranker: this.reranker.model,
            dims: this.embedder.dims,
            count: chunks.length,
          },
        });
      }
      return { usage: usage(result.tokens) };
    });
  }

  async search(
    req: SearchRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }> {
    throwIfAborted(req.signal);
    limit(req.topK);
    return this.store.run(req.docId, async () => {
      throwIfAborted(req.signal);
      const snapshot = await this.store.load(req.docId);
      if (!snapshot || !req.topK || !snapshot.chunks.length)
        return { hits: [], usage: usage() };
      let scores: number[];
      let tokens = 0;
      if (req.index === 'sparse') scores = scoreBm25(snapshot.bm25, req.query);
      else {
        this.compatible(snapshot);
        const result = await this.embedder.embed(
          [req.query],
          'query',
          req.signal,
        );
        const vector = result.vectors[0];
        if (
          !vector ||
          result.vectors.length !== 1 ||
          !Number.isSafeInteger(result.tokens) ||
          result.tokens < 0
        )
          throw new AppError('BACKEND_UNAVAILABLE', 'Invalid query embedding.');
        const query = normalize(vector, this.embedder.dims);
        tokens = result.tokens;
        scores = snapshot.vectors.map((dense) =>
          dense.reduce(
            (score, value, dim) => score + value * (query[dim] ?? 0),
            0,
          ),
        );
      }
      throwIfAborted(req.signal);
      const hits: SearchHit[] = snapshot.chunks.flatMap((chunk, row) => {
        const score = scores[row] ?? 0;
        return matchesFilter(chunk, req.filter) &&
          (req.index === 'dense' || score > 0)
          ? [{ chunk: stored(chunk), score }]
          : [];
      });
      hits.sort((a, b) => b.score - a.score);
      return { hits: hits.slice(0, req.topK), usage: usage(tokens) };
    });
  }

  getChunks(docId: string, ids: readonly string[]): Promise<StoredChunk[]> {
    return this.store.run(docId, async () => {
      const snapshot = await this.store.load(docId);
      const byId = new Map(snapshot?.chunks.map((chunk) => [chunk.id, chunk]));
      return ids.flatMap((id) => {
        const chunk = byId.get(id);
        return chunk ? [stored(chunk)] : [];
      });
    });
  }

  async rerank(
    req: RerankRequest,
  ): Promise<{ hits: SearchHit[]; usage: BackendUsage }> {
    throwIfAborted(req.signal);
    limit(req.topN);
    const unique = [
      ...new Map(req.hits.map((hit) => [hit.chunk.id, hit])).values(),
    ];
    if (!unique.length || !req.topN) return { hits: [], usage: usage() };
    let scores: number[];
    try {
      scores = await this.reranker.score(
        req.query,
        unique.map((hit) => contextualText(hit.chunk)),
        req.signal,
      );
    } catch (cause) {
      if (
        cause instanceof AppError ||
        (cause instanceof Error && cause.name === 'AbortError')
      )
        throw cause;
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Could not rerank with the local model.',
        { cause },
      );
    }
    throwIfAborted(req.signal);
    if (
      scores.length !== unique.length ||
      scores.some((score) => !Number.isFinite(score))
    )
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Local reranker returned invalid scores.',
      );
    const hits = unique
      .map((hit, row) => ({ chunk: hit.chunk, score: scores[row] ?? 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.topN);
    return { hits, usage: usage(0, unique.length) };
  }

  deleteDocument(docId: string): Promise<void> {
    return this.store.run(docId, () => this.store.delete(docId));
  }
}
