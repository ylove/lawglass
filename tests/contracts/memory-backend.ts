/**
 * In-memory RetrievalBackend test double. Scores by term overlap for both "indexes" (a crude
 * stand-in, not a real embedding), which is enough to validate the contract suite and to unit
 * test callers (core/retrieve, chips, server) without models or network.
 */
import {
  ZERO_USAGE,
  type BackendUsage,
  type Chunk,
  type ChunkFilter,
  type RetrievalBackend,
  type SearchHit,
  type StoredChunk,
} from '../../src/core/model/index.js';

const tokenize = (s: string): string[] =>
  s.toLowerCase().match(/[a-z0-9]+(?:[.$][a-z0-9]+)*/g) ?? [];

function overlapScore(query: string, text: string): number {
  const q = new Set(tokenize(query));
  const t = tokenize(text);
  if (q.size === 0 || t.length === 0) return 0;
  const hits = t.filter((w) => q.has(w)).length;
  return hits / Math.sqrt(t.length);
}

export function matchesFilter(
  c: StoredChunk,
  f: ChunkFilter | undefined,
): boolean {
  if (!f) return true;
  if (f.chunkType && !f.chunkType.includes(c.chunkType)) return false;
  if (f.amendmentStatus && !f.amendmentStatus.includes(c.amendmentStatus))
    return false;
  if (f.sectionIds && !f.sectionIds.includes(c.sectionId)) return false;
  if (
    f.definesTerm &&
    (c.definesTerm === undefined || !f.definesTerm.includes(c.definesTerm))
  )
    return false;
  return true;
}

function toStored(c: Chunk): StoredChunk {
  const { embedText: _omit, ...stored } = c;
  return stored;
}

const usage = (embedTokens = 0, rerankUnits = 0): BackendUsage => ({
  ...ZERO_USAGE,
  embedTokens,
  rerankUnits,
});

export class MemoryBackend implements RetrievalBackend {
  readonly kind = 'local' as const;
  private readonly docs = new Map<string, Map<string, Chunk>>();

  ensureReady(): Promise<void> {
    return Promise.resolve();
  }

  hasDocument(docId: string): Promise<boolean> {
    return Promise.resolve((this.docs.get(docId)?.size ?? 0) > 0);
  }

  upsertChunks(
    docId: string,
    chunks: readonly Chunk[],
    onProgress?: (p: { done: number; total: number }) => void,
  ) {
    const ns = this.docs.get(docId) ?? new Map<string, Chunk>();
    this.docs.set(docId, ns);
    chunks.forEach((c, i) => {
      ns.set(c.id, c);
      onProgress?.({ done: i + 1, total: chunks.length });
    });
    const tokens = chunks.reduce((n, c) => n + tokenize(c.embedText).length, 0);
    return Promise.resolve({ usage: usage(tokens) });
  }

  search(req: Parameters<RetrievalBackend['search']>[0]) {
    const ns = this.docs.get(req.docId);
    const hits: SearchHit[] = [...(ns?.values() ?? [])]
      .filter((c) => matchesFilter(c, req.filter))
      .map((c) => ({
        chunk: toStored(c),
        score: overlapScore(
          req.query,
          req.index === 'dense' ? c.embedText : c.text,
        ),
      }))
      .filter((h) => req.index === 'dense' || h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, req.topK);
    return Promise.resolve({ hits, usage: usage(tokenize(req.query).length) });
  }

  getChunks(docId: string, ids: readonly string[]) {
    const ns = this.docs.get(docId);
    return Promise.resolve(
      ids.flatMap((id) => (ns?.get(id) ? [toStored(ns.get(id)!)] : [])),
    );
  }

  rerank(req: Parameters<RetrievalBackend['rerank']>[0]) {
    const hits = req.hits
      .map((h) => ({
        chunk: h.chunk,
        score: overlapScore(req.query, h.chunk.text),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.topN);
    return Promise.resolve({
      hits,
      usage: usage(0, req.hits.length > 0 ? 1 : 0),
    });
  }

  deleteDocument(docId: string): Promise<void> {
    this.docs.delete(docId);
    return Promise.resolve();
  }
}
