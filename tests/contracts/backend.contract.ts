/**
 * Shared contract suite for every RetrievalBackend adapter.
 *
 * Usage in an adapter test:
 *   describeBackendContract('local', async () => ({ backend: await makeLocalBackend(tmpDir) }));
 *
 * `settle` lets eventually-consistent backends (Pinecone) wait after writes.
 * Semantic quality (does dense find paraphrases?) is measured by the eval harness, not here;
 * this suite checks behavior every adapter must share. Every assertion is written so that a
 * backend which ignores a feature (filters, stored fields, rerank) fails, rather than passing
 * vacuously.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Chunk,
  ChunkFilter,
  RetrievalBackend,
  SearchIndex,
  StoredChunk,
} from '../../src/core/model/index.js';
import { CHUNKS_A, CHUNKS_B, DOC_A, DOC_B } from './sample-chunks.js';

export interface BackendFixture {
  backend: RetrievalBackend;
  settle?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

const INDEXES: readonly SearchIndex[] = ['dense', 'sparse'];

function stored(c: Chunk): StoredChunk {
  const { embedText: _omit, ...rest } = c;
  return rest;
}

const byId = (id: string): Chunk => {
  const c = [...CHUNKS_A, ...CHUNKS_B].find((x) => x.id === id);
  if (!c) throw new Error(`unknown sample chunk ${id}`);
  return c;
};

/**
 * Filter cases. Each query matches the expected chunks AND at least one chunk the filter must
 * exclude, so an adapter that ignores the filter returns extra ids and fails.
 */
const FILTER_CASES: {
  name: string;
  filter: ChunkFilter;
  query: string;
  expected: string[];
}[] = [
  {
    name: 'chunkType (OR within field)',
    filter: { chunkType: ['penalty', 'appropriation'] },
    query: 'fined appropriated grants',
    expected: [CHUNKS_A[3]!.id, CHUNKS_A[4]!.id],
  },
  {
    name: 'amendmentStatus deleted',
    filter: { amendmentStatus: ['deleted'] },
    query: 'section repealed revised code',
    expected: [CHUNKS_A[5]!.id],
  },
  {
    name: 'sectionIds AND amendmentStatus',
    filter: { sectionIds: ['sec-5'], amendmentStatus: ['inserted'] },
    query: 'appropriated revised code',
    expected: [CHUNKS_A[4]!.id],
  },
  {
    name: 'definesTerm',
    filter: { definesTerm: ['eligible town'] },
    query: 'eligible town',
    expected: [CHUNKS_A[1]!.id],
  },
];

export function describeBackendContract(
  name: string,
  makeFixture: () => Promise<BackendFixture>,
  opts: { skip?: boolean; timeoutMs?: number } = {},
): void {
  const suite = opts.skip ? describe.skip : describe;
  suite(
    `RetrievalBackend contract: ${name}`,
    { timeout: opts.timeoutMs ?? 30_000 },
    () => {
      let fx: BackendFixture;
      const settle = () => fx.settle?.() ?? Promise.resolve();

      beforeAll(async () => {
        fx = await makeFixture();
        await fx.backend.ensureReady();
        await fx.backend.ensureReady(); // idempotent
        await fx.backend.deleteDocument(DOC_A);
        await fx.backend.deleteDocument(DOC_B);
        await settle();
      });

      afterAll(async () => {
        await fx.backend.deleteDocument(DOC_A);
        await fx.backend.deleteDocument(DOC_B);
        await fx.cleanup?.();
      });

      it('reports an unknown document as absent', async () => {
        expect(await fx.backend.hasDocument(DOC_A)).toBe(false);
      });

      it('upserts chunks into both indexes and reports usage', async () => {
        const progress: number[] = [];
        const { usage } = await fx.backend.upsertChunks(DOC_A, CHUNKS_A, (p) =>
          progress.push(p.done),
        );
        await fx.backend.upsertChunks(DOC_B, CHUNKS_B);
        await settle();
        expect(usage.embedTokens).toBeGreaterThanOrEqual(0);
        expect(progress.at(-1)).toBe(CHUNKS_A.length);
        expect(await fx.backend.hasDocument(DOC_A)).toBe(true);
      });

      it('getChunks round-trips every stored field (all chunks) and omits missing ids', async () => {
        const ids = [...CHUNKS_A.map((c) => c.id), `${DOC_A}:sec-404:0`];
        const got = await fx.backend.getChunks(DOC_A, ids);
        expect(got).toHaveLength(CHUNKS_A.length);
        const gotById = new Map(got.map((c) => [c.id, c]));
        for (const c of CHUNKS_A) {
          expect(gotById.get(c.id)).toEqual(stored(c));
          expect(gotById.get(c.id)).not.toHaveProperty('embedText');
        }
      });

      // Chunks chosen for their non-empty optional fields: definesTerm, definedTermsUsed + refs,
      // location fields, amendment status.
      const ROUND_TRIP = [
        { chunk: CHUNKS_A[1]!, query: 'eligible town municipality residents' },
        {
          chunk: CHUNKS_A[2]!,
          query: 'department award grants eligible town water treatment',
        },
        { chunk: CHUNKS_A[0]!, query: 'cited Clean Water Grants Act' },
        { chunk: CHUNKS_A[5]!, query: 'section 5747.01 revised code repealed' },
      ];
      it.each(INDEXES)(
        '%s search round-trips every stored field',
        async (index) => {
          for (const { chunk, query } of ROUND_TRIP) {
            const { hits } = await fx.backend.search({
              docId: DOC_A,
              index,
              query,
              topK: 10,
            });
            const hit = hits.find((h) => h.chunk.id === chunk.id);
            expect(
              hit,
              `${index} search for "${query}" should return ${chunk.id}`,
            ).toBeDefined();
            expect(hit?.chunk).toEqual(stored(chunk));
          }
        },
      );

      it.each(INDEXES)(
        '%s search respects topK and sorts by score',
        async (index) => {
          const { hits, usage } = await fx.backend.search({
            docId: DOC_A,
            index,
            query: 'grants for water treatment',
            topK: 2,
          });
          expect(hits.length).toBeGreaterThan(0);
          expect(hits.length).toBeLessThanOrEqual(2);
          for (let i = 1; i < hits.length; i++) {
            expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
          }
          expect(usage.readUnits).toBeGreaterThanOrEqual(0);
        },
      );

      it('sparse search ranks an exact rare token first', async () => {
        const { hits } = await fx.backend.search({
          docId: DOC_A,
          index: 'sparse',
          query: '5747.01',
          topK: 3,
        });
        expect(hits[0]?.chunk.id).toBe(CHUNKS_A[5]!.id);
      });

      it('keeps documents isolated by namespace', async () => {
        for (const index of INDEXES) {
          const { hits } = await fx.backend.search({
            docId: DOC_B,
            index,
            query: 'water treatment grants zoning noise',
            topK: 10,
          });
          expect(hits.length).toBeGreaterThan(0);
          expect(hits.every((h) => h.chunk.docId === DOC_B)).toBe(true);
        }
      });

      for (const index of INDEXES) {
        it.each(FILTER_CASES)(
          `${index} search applies filter: $name`,
          async (c) => {
            const unfiltered = await fx.backend.search({
              docId: DOC_A,
              index,
              query: c.query,
              topK: 10,
            });
            // Sanity: without the filter the query also reaches chunks the filter must exclude.
            expect(
              unfiltered.hits.some((h) => !c.expected.includes(h.chunk.id)),
            ).toBe(true);

            const { hits } = await fx.backend.search({
              docId: DOC_A,
              index,
              query: c.query,
              topK: 10,
              filter: c.filter,
            });
            expect(hits.map((h) => h.chunk.id).sort()).toEqual(
              [...c.expected].sort(),
            );
          },
        );
      }

      it('re-upserting the same chunks does not duplicate them', async () => {
        await fx.backend.upsertChunks(DOC_A, CHUNKS_A);
        await settle();
        for (const index of INDEXES) {
          const { hits } = await fx.backend.search({
            docId: DOC_A,
            index,
            query: 'act section town',
            topK: 50,
          });
          const ids = hits.map((h) => h.chunk.id);
          expect(new Set(ids).size).toBe(ids.length);
          expect(ids.length).toBeLessThanOrEqual(CHUNKS_A.length);
        }
      });

      it('reranks to exactly min(topN, n) distinct input hits, fields intact, sorted', async () => {
        const { hits } = await fx.backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'fines for violations',
          topK: 6,
        });
        expect(hits.length).toBeGreaterThanOrEqual(3);
        for (const topN of [3, hits.length + 5]) {
          const reranked = await fx.backend.rerank({
            query: 'fines for violations',
            hits,
            topN,
          });
          expect(reranked.hits).toHaveLength(Math.min(topN, hits.length));
          const ids = reranked.hits.map((h) => h.chunk.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const h of reranked.hits)
            expect(h.chunk).toEqual(stored(byId(h.chunk.id)));
          for (let i = 1; i < reranked.hits.length; i++) {
            expect(reranked.hits[i - 1]!.score).toBeGreaterThanOrEqual(
              reranked.hits[i]!.score,
            );
          }
          expect(reranked.usage.rerankUnits).toBeGreaterThanOrEqual(0);
        }
      });

      it('reranking an empty list returns an empty list', async () => {
        const { hits } = await fx.backend.rerank({
          query: 'anything',
          hits: [],
          topN: 5,
        });
        expect(hits).toEqual([]);
      });

      it('deletes a document idempotently', async () => {
        await fx.backend.deleteDocument(DOC_B);
        await fx.backend.deleteDocument(DOC_B);
        await settle();
        expect(await fx.backend.hasDocument(DOC_B)).toBe(false);
        for (const index of INDEXES) {
          const { hits } = await fx.backend.search({
            docId: DOC_B,
            index,
            query: 'zoning',
            topK: 5,
          });
          expect(hits).toEqual([]);
        }
        expect(await fx.backend.getChunks(DOC_B, [CHUNKS_B[0]!.id])).toEqual(
          [],
        );
      });
    },
  );
}
