import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { CHUNKS_A, DOC_A } from '../../../tests/contracts/sample-chunks.js';
import {
  ZERO_USAGE,
  makeChunkId,
  type Chunk,
  type RetrievalBackend,
  type SearchRequest,
} from '../model/index.js';
import {
  MAX_INJECTED_DEFINITIONS,
  termsNeedingDefinitions,
} from './definitions.js';
import { buildFilter, HYBRID_CANDIDATES, retrieve } from './retrieve.js';

/** Wraps a backend and records every call, so tests can assert on how it was driven. */
function spy(inner: RetrievalBackend) {
  const searches: SearchRequest[] = [];
  const reranks: { topN: number; n: number }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const backend: RetrievalBackend = {
    kind: inner.kind,
    ensureReady: (s) => inner.ensureReady(s),
    hasDocument: (d) => inner.hasDocument(d),
    upsertChunks: (d, c, p) => inner.upsertChunks(d, c, p),
    getChunks: (d, i) => inner.getChunks(d, i),
    deleteDocument: (d) => inner.deleteDocument(d),
    search: (req) => {
      searches.push(req);
      signals.push(req.signal);
      return inner.search(req);
    },
    rerank: (req) => {
      reranks.push({ topN: req.topN, n: req.hits.length });
      signals.push(req.signal);
      return inner.rerank(req);
    },
  };
  return { backend, searches, reranks, signals };
}

const ids = (r: { hits: { chunk: { id: string } }[] }) =>
  r.hits.map((h) => h.chunk.id);

let memory: MemoryBackend;
beforeAll(async () => {
  memory = new MemoryBackend();
  await memory.upsertChunks(DOC_A, CHUNKS_A);
});

describe('modes', () => {
  it('dense queries only the dense index with topK', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants eligible town',
      mode: 'dense',
      topK: 3,
    });
    expect(r.mode).toBe('dense');
    expect(
      s.searches.filter((q) => q.index === 'dense').length,
    ).toBeGreaterThanOrEqual(1);
    expect(s.searches.some((q) => q.index === 'sparse')).toBe(false);
    expect(s.searches[0]!.topK).toBe(3);
    expect(r.hits.filter((h) => !h.injected)).toHaveLength(3);
  });

  it('sparse queries only the sparse index and drops zero-match chunks', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'fined per day',
      mode: 'sparse',
    });
    expect(s.searches[0]!.index).toBe('sparse');
    expect(ids(r)).toEqual([makeChunkId(DOC_A, 'sec-4', 0)]);
  });

  it('hybrid fetches 40 from each index, fuses, and does not rerank', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'eligible town grants',
      mode: 'hybrid',
      topK: 4,
    });
    const main = s.searches.slice(0, 2);
    expect(main.map((q) => q.index).sort()).toEqual(['dense', 'sparse']);
    expect(main.every((q) => q.topK === HYBRID_CANDIDATES)).toBe(true);
    expect(s.reranks).toHaveLength(0);
    expect(r.hits.filter((h) => !h.injected).length).toBeLessThanOrEqual(4);
    expect(new Set(ids(r)).size).toBe(r.hits.length); // deduped
  });

  it('hybrid_rerank is the default and reranks fused candidates to top 8', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants for water treatment',
    });
    expect(r.mode).toBe('hybrid_rerank');
    expect(s.reranks).toHaveLength(1);
    expect(s.reranks[0]!.topN).toBe(8);
    expect(r.usage.rerankUnits).toBe(1);
    expect(ids(r)[0]).toBe(makeChunkId(DOC_A, 'sec-3', 0));
  });

  it('rerankTopN overrides the rerank size', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'eligible town',
      rerankTopN: 1,
    });
    expect(s.reranks[0]!.topN).toBe(1);
    expect(r.hits.filter((h) => !h.injected)).toHaveLength(1);
  });

  it('skips the rerank call when nothing was found', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: 'missing-doc',
      query: 'anything',
    });
    expect(s.reranks).toHaveLength(0);
    expect(r.hits).toEqual([]);
  });
});

describe('fusion selection', () => {
  /** Backend returning fixed lists per index, to prove which fusion produced the order. */
  const scripted = (): RetrievalBackend => {
    const stored = (id: string) =>
      ({ id, definedTermsUsed: [] }) as unknown as Chunk;
    const lists = {
      dense: [stored('a'), stored('b')],
      sparse: [stored('b'), stored('c')],
    };
    const scores = { dense: [0.99, 0.01], sparse: [100, 1] };
    return {
      ...spy(memory).backend,
      search: (req: SearchRequest) =>
        Promise.resolve({
          hits: lists[req.index].map((chunk, i) => ({
            chunk: chunk as never,
            score: scores[req.index][i]!,
          })),
          usage: ZERO_USAGE,
        }),
    };
  };

  it('uses RRF by default', async () => {
    const r = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
    });
    expect(ids(r)).toEqual(['b', 'a', 'c']);
  });

  it('uses weighted min-max when asked, honouring sparseWeight', async () => {
    const dense = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
      fusion: 'weighted',
      sparseWeight: 0,
    });
    expect(ids(dense)).toEqual(['a', 'b', 'c']);
    const sparse = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
      fusion: 'weighted',
      sparseWeight: 1,
    });
    expect(ids(sparse)).toEqual(['b', 'a', 'c']); // a and c tie at 0; a was seen first;
  });
});

describe('deleted spans', () => {
  const deletedId = makeChunkId(DOC_A, 'sec-5', 1);

  it('excludes deleted chunks by default via a backend-side filter', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      mode: 'sparse',
    });
    expect(ids(r)).not.toContain(deletedId);
    expect(s.searches[0]!.filter?.amendmentStatus).toEqual([
      'unchanged',
      'inserted',
    ]);
  });

  it('includes them with includeDeleted', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      mode: 'sparse',
      includeDeleted: true,
    });
    expect(ids(r)).toContain(deletedId);
  });

  it('buildFilter merges chip filters and intersects explicit statuses', () => {
    expect(buildFilter(undefined, true)).toBeUndefined();
    expect(buildFilter({ chunkType: ['penalty'] }, false)).toEqual({
      chunkType: ['penalty'],
      amendmentStatus: ['unchanged', 'inserted'],
    });
    expect(
      buildFilter({ amendmentStatus: ['inserted', 'deleted'] }, false),
    ).toEqual({
      amendmentStatus: ['inserted'],
    });
    expect(buildFilter({ amendmentStatus: ['deleted'] }, true)).toEqual({
      amendmentStatus: ['deleted'],
    });
    expect(buildFilter({ amendmentStatus: ['deleted'] }, false)).toBeNull();
  });

  it('returns nothing, without searching, when the chip only wants deleted text but deletions are excluded', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'repealed',
      filter: { amendmentStatus: ['deleted'] },
    });
    expect(r.hits).toEqual([]);
    expect(s.searches).toHaveLength(0);
  });

  it('passes chip filters through to the backend', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'fined appropriated effect',
      mode: 'dense',
      filter: { chunkType: ['penalty'] },
    });
    expect(
      r.hits.every((h) => h.chunk.chunkType === 'penalty' || h.injected),
    ).toBe(true);
    expect(ids(r)).toContain(makeChunkId(DOC_A, 'sec-4', 0));
  });
});

describe('definition injection', () => {
  const defChunk = (term: string): Chunk => ({
    ...CHUNKS_A[1]!,
    id: makeChunkId(DOC_A, `def-${term}`, 0),
    sectionId: `def-${term}`,
    text: `The term "${term}" means something.`,
    embedText: `Definitions: ${term}`,
    definesTerm: term,
  });
  const user = (n: number, terms: string[]): Chunk => ({
    ...CHUNKS_A[2]!,
    id: makeChunkId(DOC_A, `use-${String(n)}`, 0),
    sectionId: `use-${String(n)}`,
    text: `widget rule ${String(n)}`,
    embedText: `widget rule ${String(n)}`,
    definedTermsUsed: terms,
  });

  it('appends the definition of a used term and marks it injected', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'award grants water treatment upgrades',
      mode: 'sparse',
      topK: 1,
    });
    expect(ids(r)).toEqual([
      makeChunkId(DOC_A, 'sec-3', 0),
      makeChunkId(DOC_A, 'sec-2', 0),
    ]);
    expect(r.hits.map((h) => h.injected)).toEqual([false, true]);
    expect(r.injectedDefinitions.map((c) => c.definesTerm)).toEqual([
      'eligible town',
    ]);
  });

  it('does not inject a definition that is already among the hits', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'eligible town municipality grants',
      mode: 'sparse',
    });
    expect(ids(r)).toContain(makeChunkId(DOC_A, 'sec-2', 0));
    expect(r.injectedDefinitions).toEqual([]);
  });

  it('caps injection at 5, preferring the most-used terms', async () => {
    const backend = new MemoryBackend();
    const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    // t7 is used by two hits, so it must survive the cap even though it sorts last.
    await backend.upsertChunks(DOC_A, [
      ...terms.map(defChunk),
      user(1, terms),
      user(2, ['t7']),
    ]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      topK: 2,
    });
    expect(r.injectedDefinitions).toHaveLength(MAX_INJECTED_DEFINITIONS);
    expect(r.injectedDefinitions[0]!.definesTerm).toBe('t7');
    expect(r.injectedDefinitions.map((c) => c.definesTerm)).toEqual([
      't7',
      't1',
      't2',
      't3',
      't4',
    ]);
  });

  it('does not inject deleted definitions unless includeDeleted', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, [
      { ...defChunk('t1'), amendmentStatus: 'deleted' },
      user(1, ['t1']),
    ]);
    const q = { docId: DOC_A, query: 'widget rule', mode: 'sparse' as const };
    expect((await retrieve(backend, q)).injectedDefinitions).toEqual([]);
    expect(
      (await retrieve(backend, { ...q, includeDeleted: true }))
        .injectedDefinitions,
    ).toHaveLength(1);
  });

  it('ignores terms with no definition chunk', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, [user(1, ['ghost'])]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
    });
    expect(r.injectedDefinitions).toEqual([]);
  });

  it('termsNeedingDefinitions ranks by hit count, then alphabetically, skipping covered terms', () => {
    const mk = (c: Partial<Chunk>) => ({
      chunk: { definedTermsUsed: [], ...c } as never,
      score: 1,
    });
    expect(
      termsNeedingDefinitions([
        mk({ definedTermsUsed: ['b', 'a', 'a', 'covered'] }),
        mk({ definedTermsUsed: ['b'] }),
        mk({ definesTerm: 'covered' }),
      ]),
    ).toEqual(['b', 'a']);
  });
});

describe('usage, latency and abort', () => {
  it('sums usage over every backend call', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'grants for water',
      mode: 'hybrid_rerank',
    });
    // dense + sparse query tokens (3 each) + definition lookup + one rerank unit
    expect(r.usage.embedTokens).toBeGreaterThanOrEqual(6);
    expect(r.usage.rerankUnits).toBe(1);
  });

  it('measures latency with the injected clock', async () => {
    const ticks = [1000, 1042];
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'grants',
      now: () => ticks.shift()!,
    });
    expect(r.latencyMs).toBe(42);
  });

  it('passes the abort signal to every backend call', async () => {
    const s = spy(memory);
    const controller = new AbortController();
    await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants for eligible town',
      signal: controller.signal,
    });
    expect(s.signals.length).toBeGreaterThanOrEqual(3);
    expect(s.signals.every((sig) => sig === controller.signal)).toBe(true);
  });

  it('rejects immediately when already aborted', async () => {
    const s = spy(memory);
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieve(s.backend, {
        docId: DOC_A,
        query: 'x',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(s.searches).toHaveLength(0);
  });
});
