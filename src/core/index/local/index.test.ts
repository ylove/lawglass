import { randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { describeBackendContract } from '../../../../tests/contracts/backend.contract.js';
import {
  FakeEmbedder,
  FakeReranker,
} from '../../../../tests/contracts/fake-local-models.js';
import { MemoryBackend } from '../../../../tests/contracts/memory-backend.js';
import { CHUNKS_A, DOC_A } from '../../../../tests/contracts/sample-chunks.js';
import { AppError, ZERO_USAGE } from '../../model/index.js';
import { LocalBackend, matchesFilter } from './index.js';

describeBackendContract('local (fake models)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'local-contract-'));
  return {
    backend: new LocalBackend({
      root,
      embedder: new FakeEmbedder(),
      reranker: new FakeReranker(),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
});

describe('local backend', () => {
  let root: string;
  let embedder: FakeEmbedder;
  let reranker: FakeReranker;
  let backend: LocalBackend;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'local-unit-'));
    embedder = new FakeEmbedder();
    reranker = new FakeReranker();
    backend = new LocalBackend({ root, embedder, reranker });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(['ensureReady', 'hasDocument'] as const)(
    'sweeps stale staging directories before %s completes',
    async (initialize) => {
      const stale = join(root, `${DOC_A}.${randomUUID()}.tmp`);
      await mkdir(stale);
      const modified = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await utimes(stale, modified, modified);
      if (initialize === 'ensureReady') await backend.ensureReady();
      else expect(await backend.hasDocument(DOC_A)).toBe(false);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('persists all four files, normalized vectors, and round-trips through a new adapter', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(await readdir(join(root, DOC_A))).toEqual([
      'bm25.json',
      'chunks.jsonl',
      'dense.f32',
      'meta.json',
    ]);
    const bytes = await readFile(join(root, DOC_A, 'dense.f32'));
    expect(bytes.length).toBe(CHUNKS_A.length * 384 * 4);
    let sum = 0;
    for (let i = 0; i < 384; i++) sum += bytes.readFloatLE(i * 4) ** 2;
    expect(sum).toBeCloseTo(1);
    const reopened = new LocalBackend({ root, embedder, reranker });
    const reference = new MemoryBackend();
    await reference.upsertChunks(DOC_A, CHUNKS_A);
    expect(
      await reopened.getChunks(
        DOC_A,
        CHUNKS_A.map((c) => c.id),
      ),
    ).toEqual(
      await reference.getChunks(
        DOC_A,
        CHUNKS_A.map((c) => c.id),
      ),
    );
    expect(
      await reopened.search({
        docId: DOC_A,
        index: 'dense',
        query: 'grants',
        topK: 1,
      }),
    ).toEqual(
      await backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'grants',
        topK: 1,
      }),
    );
  });

  it('upserts partial batches, replaces rows, and spends no tokens on identical embedding text', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A.slice(0, 2));
    await backend.upsertChunks(DOC_A, CHUNKS_A.slice(2));
    expect((await backend.upsertChunks(DOC_A, CHUNKS_A)).usage).toEqual(
      ZERO_USAGE,
    );
    expect(embedder.calls).toHaveLength(2);
    const updated = {
      ...CHUNKS_A[0]!,
      text: 'replaced',
      embedText: 'replaced',
    };
    await backend.upsertChunks(DOC_A, [updated, updated]);
    expect(embedder.calls.at(-1)?.texts).toEqual(['replaced']);
    expect(await backend.getChunks(DOC_A, [updated.id])).toEqual([
      expect.objectContaining({ text: 'replaced' }),
    ]);
    const metadataOnly = { ...updated, heading: 'New heading' };
    expect(
      (await backend.upsertChunks(DOC_A, [metadataOnly])).usage.embedTokens,
    ).toBe(0);
    const { hits } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: 'replaced',
      topK: 50,
    });
    expect(hits).toHaveLength(CHUNKS_A.length);
    expect(hits[0]?.chunk.id).toBe(updated.id);
  });

  it('reuses the original vector when the last duplicate restores its embedding text', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const original = CHUNKS_A[0]!;
    const restored = { ...original, heading: 'Updated heading' };
    const result = await backend.upsertChunks(DOC_A, [
      { ...original, embedText: 'temporary replacement' },
      restored,
    ]);
    expect(result.usage).toEqual(ZERO_USAGE);
    expect(embedder.calls).toHaveLength(1);
    expect(await backend.getChunks(DOC_A, [original.id])).toEqual([
      expect.objectContaining({
        heading: restored.heading,
        text: original.text,
      }),
    ]);
    const { hits } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: original.embedText,
      topK: 1,
    });
    expect(hits[0]?.chunk.id).toBe(original.id);
    expect(hits[0]?.score).toBeCloseTo(1);
  });

  it('serializes concurrent batches across instances without losing rows', async () => {
    const second = new LocalBackend({ root, embedder, reranker });
    await Promise.all([
      backend.upsertChunks(DOC_A, CHUNKS_A.slice(0, 2)),
      second.upsertChunks(DOC_A, CHUNKS_A.slice(2)),
    ]);
    expect(
      await backend.getChunks(
        DOC_A,
        CHUNKS_A.map((c) => c.id),
      ),
    ).toHaveLength(CHUNKS_A.length);
  });

  it('handles empty documents, absent namespaces, zero limits and zero vectors', async () => {
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'a',
          topK: 5,
        })
      ).usage,
    ).toEqual(ZERO_USAGE);
    expect((await backend.upsertChunks(DOC_A, [])).usage).toEqual(ZERO_USAGE);
    expect(await backend.hasDocument(DOC_A)).toBe(true);
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'a',
          topK: 5,
        })
      ).hits,
    ).toEqual([]);
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'the',
          topK: 1,
        })
      ).hits[0]?.score,
    ).toBe(0);
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'grants',
          topK: 0,
        })
      ).hits,
    ).toEqual([]);
    const sparse = await backend.search({
      docId: DOC_A,
      index: 'sparse',
      query: 'unmatched',
      topK: 5,
    });
    expect(sparse).toEqual({ hits: [], usage: ZERO_USAGE });
    await backend.dispose();
  });

  it('passes embedding text, queries and raw reranking text to their respective adapters', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(embedder.calls[0]).toEqual({
      texts: CHUNKS_A.map((c) => c.embedText),
      purpose: 'document',
    });
    const { hits, usage } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: 'grant water',
      topK: 3,
    });
    expect(usage.embedTokens).toBe(2);
    expect(embedder.calls.at(-1)).toEqual({
      texts: ['grant water'],
      purpose: 'query',
    });
    const score = vi.spyOn(reranker, 'score');
    const reranked = await backend.rerank({
      query: 'grant water',
      hits: [...hits, hits[0]!],
      topN: 20,
    });
    expect(score).toHaveBeenCalledWith(
      'grant water',
      hits.map((hit) => hit.chunk.text),
      undefined,
    );
    expect(reranked.usage.rerankUnits).toBe(3);
    expect(reranked.hits).toHaveLength(3);
    expect((await backend.rerank({ query: '', hits, topN: 0 })).usage).toEqual(
      ZERO_USAGE,
    );
  });

  it('rejects unsafe namespaces, incorrect chunk namespaces and invalid result limits', async () => {
    for (const docId of ['../escape', '/tmp/escape', '.', 'a/b', ''])
      await expect(backend.hasDocument(docId)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    await expect(backend.upsertChunks('other', CHUNKS_A)).rejects.toMatchObject(
      { code: 'INVALID_INPUT' },
    );
    await expect(
      backend.upsertChunks(DOC_A, [{ ...CHUNKS_A[0]!, text: '' }]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const topK of [-1, 1.5, NaN, Infinity])
      await expect(
        backend.search({ docId: DOC_A, index: 'dense', query: '', topK }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      backend.rerank({ query: '', hits: [], topN: -1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects model changes for dense search and upsert while stored and sparse access remain usable', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const changed = new FakeEmbedder();
    changed.model.revision = '2';
    const other = new LocalBackend({ root, embedder: changed, reranker });
    await expect(
      other.search({ docId: DOC_A, index: 'dense', query: 'grants', topK: 1 }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    await expect(other.upsertChunks(DOC_A, CHUNKS_A)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    expect(
      (
        await other.search({
          docId: DOC_A,
          index: 'sparse',
          query: '5747.01',
          topK: 1,
        })
      ).hits[0]?.chunk.id,
    ).toBe(CHUNKS_A[5]!.id);
    expect(await other.getChunks(DOC_A, [CHUNKS_A[0]!.id])).toHaveLength(1);
  });

  it('keeps the prior document intact after embedding failures and permits retry', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    vi.spyOn(embedder, 'embed').mockRejectedValueOnce(new Error('offline'));
    const updated = { ...CHUNKS_A[0]!, embedText: 'replacement' };
    await expect(backend.upsertChunks(DOC_A, [updated])).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    expect(await backend.getChunks(DOC_A, [updated.id])).toEqual([
      expect.objectContaining({ text: updated.text }),
    ]);
    await backend.upsertChunks(DOC_A, [updated]);
    expect(await readdir(root)).toEqual([DOC_A]);
  });

  it('rejects malformed model vectors, counts, and reranker scores before publication', async () => {
    const embed = vi.spyOn(embedder, 'embed');
    for (const vectors of [
      [],
      [new Float32Array(1)],
      [new Float32Array(384).fill(NaN)],
    ]) {
      embed.mockResolvedValueOnce({ vectors, tokens: 1 });
      await expect(
        backend.upsertChunks(DOC_A, [CHUNKS_A[0]!]),
      ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
      expect(await backend.hasDocument(DOC_A)).toBe(false);
    }
    embed.mockResolvedValueOnce({
      vectors: [new Float32Array(384)],
      tokens: -1,
    });
    await expect(
      backend.upsertChunks(DOC_A, [CHUNKS_A[0]!]),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    embed.mockRestore();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const queryEmbed = vi.spyOn(embedder, 'embed').mockResolvedValueOnce({
      vectors: [],
      tokens: 0,
    });
    await expect(
      backend.search({ docId: DOC_A, index: 'dense', query: '', topK: 1 }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    queryEmbed.mockRestore();
    const { hits } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: 'grants',
      topK: 1,
    });
    for (const scores of [[], [NaN], [Infinity]]) {
      vi.spyOn(reranker, 'score').mockResolvedValueOnce(scores);
      await expect(
        backend.rerank({ query: '', hits, topN: 1 }),
      ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    }
  });

  it('fails clearly on corrupt files', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    await writeFile(join(root, DOC_A, 'dense.f32'), 'truncated');
    await expect(backend.getChunks(DOC_A, [])).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
  });

  it('wraps rerank inference failures and preserves application and abort errors', async () => {
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const { hits } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: 'grants',
      topK: 1,
    });
    const score = vi.spyOn(reranker, 'score');
    score.mockRejectedValueOnce(new Error('inference failed'));
    await expect(
      backend.rerank({ query: 'grants', hits, topN: 1 }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    for (const error of [
      new AppError('BACKEND_UNAVAILABLE'),
      new DOMException('cancelled', 'AbortError'),
    ]) {
      score.mockRejectedValueOnce(error);
      await expect(
        backend.rerank({ query: 'grants', hits, topN: 1 }),
      ).rejects.toBe(error);
    }
  });

  it('rejects aborted operations and checks cancellation after inference', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(backend.ensureReady(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    await expect(
      backend.search({
        docId: DOC_A,
        index: 'dense',
        query: '',
        topK: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      backend.rerank({
        query: '',
        hits: [],
        topN: 1,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const during = new AbortController();
    vi.spyOn(embedder, 'embed').mockImplementationOnce(() => {
      during.abort();
      return Promise.resolve({ vectors: [new Float32Array(384)], tokens: 1 });
    });
    await expect(
      backend.search({
        docId: DOC_A,
        index: 'dense',
        query: '',
        topK: 1,
        signal: during.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('matches all filter fields as AND, with OR values within a field', () => {
    expect(matchesFilter(CHUNKS_A[0]!, {})).toBe(true);
    expect(
      matchesFilter(CHUNKS_A[0]!, { definesTerm: ['eligible town'] }),
    ).toBe(false);
    expect(matchesFilter(CHUNKS_A[1]!, { definesTerm: ['unknown'] })).toBe(
      false,
    );
    expect(
      matchesFilter(CHUNKS_A[1]!, {
        definesTerm: ['unknown', 'eligible town'],
        chunkType: ['definition'],
        sectionIds: ['sec-2'],
      }),
    ).toBe(true);
  });
});
