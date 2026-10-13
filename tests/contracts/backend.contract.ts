/**
 * Shared contract suite for every RetrievalBackend adapter.
 *
 * Usage in an adapter test:
 *   describeBackendContract('local', async () => ({ backend: await makeLocalBackend(tmpDir) }));
 *
 * `settle` lets eventually-consistent backends (Pinecone) wait after writes.
 * Semantic quality (does dense find paraphrases?) is measured by the eval harness, not here;
 * this suite checks behavior every adapter must share.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RetrievalBackend } from '../../src/core/model/index.js';
import { CHUNKS_A, CHUNKS_B, DOC_A, DOC_B } from './sample-chunks.js';

export interface BackendFixture {
  backend: RetrievalBackend;
  settle?: () => Promise<void>;
  cleanup?: () => Promise<void>;
}

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

      it('round-trips chunk fields (except embedText) through search', async () => {
        const { hits } = await fx.backend.search({
          docId: DOC_A,
          index: 'sparse',
          query: 'cited Clean Water Grants Act',
          topK: 3,
        });
        const hit = hits.find((h) => h.chunk.id === CHUNKS_A[0]!.id);
        expect(hit).toBeDefined();
        const { embedText: _omit, ...expected } = CHUNKS_A[0]!;
        expect(hit!.chunk).toMatchObject(expected);
        expect(hit!.chunk).not.toHaveProperty('embedText');
      });

      it.each(['dense', 'sparse'] as const)(
        '%s search respects topK and sorts by score',
        async (index) => {
          const { hits, usage } = await fx.backend.search({
            docId: DOC_A,
            index,
            query: 'grants for water treatment',
            topK: 2,
          });
          expect(hits.length).toBeLessThanOrEqual(2);
          expect(hits.length).toBeGreaterThan(0);
          for (let i = 1; i < hits.length; i++)
            expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
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
        for (const index of ['dense', 'sparse'] as const) {
          const { hits } = await fx.backend.search({
            docId: DOC_B,
            index,
            query: 'water treatment grants',
            topK: 10,
          });
          expect(hits.every((h) => h.chunk.docId === DOC_B)).toBe(true);
        }
      });

      it('applies typed filters (AND across fields, OR within a field)', async () => {
        const q = {
          docId: DOC_A,
          index: 'dense' as const,
          query: 'what does this act do',
          topK: 10,
        };
        const byType = await fx.backend.search({
          ...q,
          filter: { chunkType: ['penalty', 'appropriation'] },
        });
        expect(new Set(byType.hits.map((h) => h.chunk.chunkType))).toEqual(
          new Set(['penalty', 'appropriation']),
        );

        const deleted = await fx.backend.search({
          ...q,
          filter: { amendmentStatus: ['deleted'] },
        });
        expect(deleted.hits.map((h) => h.chunk.id)).toEqual([CHUNKS_A[5]!.id]);

        const both = await fx.backend.search({
          ...q,
          filter: { sectionIds: ['sec-5'], amendmentStatus: ['inserted'] },
        });
        expect(both.hits.map((h) => h.chunk.id)).toEqual([CHUNKS_A[4]!.id]);

        const defs = await fx.backend.search({
          ...q,
          filter: { definesTerm: ['eligible town'] },
        });
        expect(defs.hits.map((h) => h.chunk.id)).toEqual([CHUNKS_A[1]!.id]);
      });

      it('re-upserting the same chunks does not duplicate them', async () => {
        await fx.backend.upsertChunks(DOC_A, CHUNKS_A);
        await settle();
        const { hits } = await fx.backend.search({
          docId: DOC_A,
          index: 'sparse',
          query: 'act',
          topK: 50,
        });
        const ids = hits.map((h) => h.chunk.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it('gets chunks by id and omits missing ids', async () => {
        const wanted = [CHUNKS_A[1]!.id, CHUNKS_A[3]!.id, `${DOC_A}:sec-404:0`];
        const got = await fx.backend.getChunks(DOC_A, wanted);
        expect(got.map((c) => c.id).sort()).toEqual(
          [CHUNKS_A[1]!.id, CHUNKS_A[3]!.id].sort(),
        );
      });

      it('reranks to at most topN, a subset of the input, sorted by score', async () => {
        const { hits } = await fx.backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'fines for violations',
          topK: 6,
        });
        const reranked = await fx.backend.rerank({
          query: 'fines for violations',
          hits,
          topN: 3,
        });
        expect(reranked.hits.length).toBeLessThanOrEqual(3);
        const inputIds = new Set(hits.map((h) => h.chunk.id));
        expect(reranked.hits.every((h) => inputIds.has(h.chunk.id))).toBe(true);
        for (let i = 1; i < reranked.hits.length; i++) {
          expect(reranked.hits[i - 1]!.score).toBeGreaterThanOrEqual(
            reranked.hits[i]!.score,
          );
        }
        expect(reranked.usage.rerankUnits).toBeGreaterThanOrEqual(0);
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
        const { hits } = await fx.backend.search({
          docId: DOC_B,
          index: 'sparse',
          query: 'zoning',
          topK: 5,
        });
        expect(hits).toEqual([]);
      });
    },
  );
}
