import type {
  FetchOptions,
  SearchRecordsOptions,
  UpsertRecordsOptions,
  CreateIndexForModelOptions,
  RerankOptions,
  IntegratedRecord,
} from '@pinecone-database/pinecone';
import { Errors } from '@pinecone-database/pinecone';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeBackendContract } from '../../../../tests/contracts/backend.contract.js';
import { MemoryBackend } from '../../../../tests/contracts/memory-backend.js';
import {
  CHUNKS_A,
  CHUNKS_B,
  DOC_A,
  DOC_B,
} from '../../../../tests/contracts/sample-chunks.js';
import { BRAND } from '../../brand.js';
import { pineconeConfig } from '../../config.js';
import {
  AppError,
  ZERO_USAGE,
  type ChunkFilter,
  type UpsertProgress,
} from '../../model/index.js';
import { fromRecord, toRecord } from './metadata.js';
import { PineconeBackend, settle, type PineconeClient } from './pinecone.js';

const defaults = pineconeConfig({}, {});
function fakeSdk() {
  function fakeIndex(kind: 'dense' | 'sparse') {
    const memory = new MemoryBackend();
    const records = new Map<string, Set<string>>();
    const storedRecords = new Map<string, Map<string, IntegratedRecord>>();
    const upsert = vi.fn(
      async (
        docId: string,
        options: UpsertRecordsOptions,
      ): Promise<unknown> => {
        const chunks = options.records
          .filter((record) => record.section_id !== undefined)
          .map((record) => ({
            ...fromRecord(String(record._id), record, docId),
            embedText: String(record.embed_text),
          }));
        await memory.upsertChunks(docId, chunks);
        const ids = records.get(docId) ?? new Set<string>();
        const stored =
          storedRecords.get(docId) ?? new Map<string, IntegratedRecord>();
        for (const record of options.records) {
          const id = String(record._id);
          ids.add(id);
          stored.set(id, record);
        }
        records.set(docId, ids);
        storedRecords.set(docId, stored);
        return undefined; // The pinned SDK returns void, not a usage object.
      },
    );
    const search = vi.fn(
      async (
        docId: string,
        options: SearchRecordsOptions,
      ): Promise<unknown> => {
        const query = options.query.inputs as { text: string };
        const filter: ChunkFilter = {};
        const translated = options.query.filter as
          { $and: Record<string, { $in: string[] }>[] } | undefined;
        for (const clause of translated?.$and ?? []) {
          if (clause.section_id) filter.sectionIds = clause.section_id.$in;
          if (clause.defines_term) filter.definesTerm = clause.defines_term.$in;
          if (clause.chunk_type)
            filter.chunkType = clause.chunk_type.$in as NonNullable<
              ChunkFilter['chunkType']
            >;
          if (clause.amendment_status)
            filter.amendmentStatus = clause.amendment_status.$in as NonNullable<
              ChunkFilter['amendmentStatus']
            >;
        }
        const response = await memory.search({
          docId,
          index: kind,
          query: query.text,
          topK: options.query.topK,
          filter,
        });
        return {
          result: {
            hits: response.hits.map((hit) => ({
              _id: hit.chunk.id,
              _score: hit.score,
              fields: toRecord({ ...hit.chunk, embedText: hit.chunk.text }),
            })),
          },
          usage: { readUnits: 1, embedTotalTokens: 3 },
        };
      },
    );
    const fetch = vi.fn(
      (docId: string, options: FetchOptions): Promise<unknown> =>
        Promise.resolve({
          records: Object.fromEntries(
            options.ids.flatMap((id) => {
              const record = storedRecords.get(docId)?.get(id);
              return record ? [[id, { id, metadata: record }]] : [];
            }),
          ),
          usage: { readUnits: 1 },
        }),
    );
    const stats = vi.fn((): Promise<unknown> =>
      Promise.resolve({
        namespaces: Object.fromEntries(
          [...records].map(([id, ids]) => [id, { recordCount: ids.size }]),
        ),
      }),
    );
    const deleteNamespace = vi.fn(async (docId: string): Promise<unknown> => {
      await memory.deleteDocument(docId);
      records.delete(docId);
      storedRecords.delete(docId);
      return undefined;
    });
    return {
      memory,
      upsert,
      search,
      fetch,
      records,
      describeIndexStats: stats,
      deleteNamespace,
      namespace: (docId: string) => ({
        upsertRecords: (options: UpsertRecordsOptions) =>
          upsert(docId, options),
        searchRecords: (options: SearchRecordsOptions) =>
          search(docId, options),
        fetch: (options: FetchOptions) => fetch(docId, options),
      }),
    };
  }
  const dense = fakeIndex('dense');
  const sparse = fakeIndex('sparse');
  const describeIndex = vi.fn((name: string): Promise<unknown> =>
    Promise.resolve({
      host: `${name}.example.org`,
      status: { ready: true },
      deployment: {
        deploymentType: 'managed',
        cloud: 'aws',
        region: 'us-east-1',
      },
      schema: {
        fields: {
          embed_text: {
            type: 'semantic_text',
            model: name.endsWith('dense')
              ? defaults.denseModel
              : defaults.sparseModel,
          },
        },
      },
    }),
  );
  const create = vi.fn(
    (_options: CreateIndexForModelOptions): Promise<unknown> =>
      Promise.resolve(undefined),
  );
  const rerank = vi.fn(async (options: RerankOptions): Promise<unknown> => {
    const documents = options.documents as { id: string; text: string }[];
    const chunks = await dense.memory.getChunks(
      DOC_A,
      documents.map((doc) => doc.id),
    );
    const response = await dense.memory.rerank({
      query: options.query,
      topN: options.topN ?? documents.length,
      hits: chunks.map((chunk) => ({ chunk, score: 0 })),
    });
    return {
      data: response.hits.map((hit) => ({
        index: documents.findIndex((doc) => doc.id === hit.chunk.id),
        score: hit.score,
      })),
      usage: { rerankUnits: 1 },
    };
  });
  const client: PineconeClient = {
    indexes: { createForModel: create, describe: describeIndex },
    index: (name) => (name.endsWith('dense') ? dense : sparse),
    inference: { rerank },
  };
  return { client, dense, sparse, create, describeIndex, rerank };
}

afterEach(() => {
  vi.restoreAllMocks();
});
function setup(config: Parameters<typeof pineconeConfig>[0] = {}) {
  const sdk = fakeSdk();
  const logUsage = vi.fn();
  const backend = new PineconeBackend({
    client: sdk.client,
    logUsage,
    config: { ...defaults, pollIntervalMs: 1, timeoutMs: 20, ...config },
  });
  return { backend, sdk, logUsage };
}

// Reuse the real behavioral contract and MemoryBackend to drive fake SDK scoring.
describeBackendContract('pinecone (mock SDK)', () => {
  const sdk = fakeSdk();
  const backend = new PineconeBackend({
    client: sdk.client,
    config: defaults,
    logUsage: () => undefined,
  });
  return Promise.resolve({
    backend,
    settle: () => backend.settle(),
  });
});

describe('PineconeBackend', () => {
  it('creates both branded model indexes idempotently and uses their hosts', async () => {
    const { backend, sdk } = setup();
    await Promise.all([backend.ensureReady(), backend.ensureReady()]);
    expect(sdk.create).toHaveBeenCalledTimes(2);
    for (const kind of ['dense', 'sparse'] as const)
      expect(sdk.create).toHaveBeenCalledWith({
        name: `${BRAND.indexPrefix}${kind}`,
        cloud: 'aws',
        region: 'us-east-1',
        embed: {
          model: kind === 'dense' ? defaults.denseModel : defaults.sparseModel,
          fieldMap: { text: 'embed_text' },
        },
        suppressConflicts: true,
      });
    expect(backend.kind).toBe('pinecone');
    expect(backend.indexNames).toEqual({
      dense: `${BRAND.indexPrefix}dense`,
      sparse: `${BRAND.indexPrefix}sparse`,
    });
  });
  it('polls existing initializing indexes and retries ensureReady after failures', async () => {
    const { backend, sdk } = setup();
    sdk.describeIndex.mockResolvedValueOnce({
      host: 'host',
      status: { ready: false },
      deployment: { deploymentType: 'managed' },
      schema: { fields: {} },
    });
    await backend.ensureReady();
    expect(sdk.describeIndex).toHaveBeenCalledTimes(3);
    const retry = setup();
    retry.sdk.create.mockRejectedValueOnce(new Error('network'));
    await expect(retry.backend.ensureReady()).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    await retry.backend.ensureReady();
  });
  it.each(['wrong model', 'wrong field', 'wrong region', 'failed', 'timeout'])(
    'rejects incompatible or unready indexes: %s',
    async (mode) => {
      const { backend, sdk } = setup({ timeoutMs: 1 });
      const valid = await sdk.describeIndex('dense');
      const description = valid as {
        status: { ready: boolean; state?: string };
        deployment: { region: string };
        schema: { fields: { embed_text?: { model: string; type: string } } };
      };
      if (mode === 'wrong model')
        description.schema.fields.embed_text!.model = 'other';
      if (mode === 'wrong field') delete description.schema.fields.embed_text;
      if (mode === 'wrong region') description.deployment.region = 'us-west-2';
      if (mode === 'failed' || mode === 'timeout') {
        description.status.ready = false;
        description.status.state =
          mode === 'failed' ? 'InitializationFailed' : 'Initializing';
      }
      sdk.describeIndex.mockResolvedValue(description);
      await expect(backend.ensureReady()).rejects.toMatchObject({
        code: 'BACKEND_UNAVAILABLE',
      });
    },
  );
  it('batches at 96 records with identical IDs and namespaces, progress only after both writes', async () => {
    const { backend, sdk, logUsage } = setup();
    await backend.ensureReady();
    const chunks = Array.from({ length: 193 }, (_, n) => ({
      ...CHUNKS_A[0]!,
      id: `${DOC_A}:sec-1:${String(n)}`,
    }));
    const progress = vi.fn<(p: UpsertProgress) => void>();
    const response = await backend.upsertChunks(DOC_A, chunks, progress);
    for (const index of [sdk.dense, sdk.sparse]) {
      const calls = index.upsert.mock.calls.filter((call) => call[0] === DOC_A);
      expect(calls.map((call) => call[1].records.length)).toEqual([96, 96, 1]);
    }
    expect(
      sdk.dense.upsert.mock.calls.filter((call) => call[0] === DOC_A),
    ).toEqual(sdk.sparse.upsert.mock.calls);
    expect(progress.mock.calls.map((call) => call[0])).toEqual([
      { done: 96, total: 193 },
      { done: 192, total: 193 },
      { done: 193, total: 193 },
    ]);
    expect(response.usage).toEqual(ZERO_USAGE);
    expect(logUsage).toHaveBeenCalledTimes(8);
    await backend.settle();
  });
  it('also batches by NDJSON byte size, including multibyte text', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    const chunks = Array.from({ length: 96 }, (_, n) => ({
      ...CHUNKS_A[0]!,
      id: `${DOC_A}:sec-1:${String(n)}`,
      text: 'é'.repeat(19_000),
      embedText: 'tiny',
    }));
    await backend.upsertChunks(DOC_A, chunks);
    expect(sdk.dense.upsert.mock.calls.length).toBeGreaterThan(1);
    for (const [, options] of sdk.dense.upsert.mock.calls)
      expect(
        Buffer.byteLength(
          options.records
            .map((record: unknown) => JSON.stringify(record))
            .join('\n'),
        ),
      ).toBeLessThanOrEqual(2_000_000);
  });
  it('fetches in batches of 1000 and preserves input order and missing IDs', async () => {
    const { backend, sdk, logUsage } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const ids = [
      CHUNKS_A[2]!.id,
      ...Array.from({ length: 1_000 }, (_, n) => `missing-${String(n)}`),
      CHUNKS_A[0]!.id,
    ];
    expect(
      (await backend.getChunks(DOC_A, ids)).map((chunk) => chunk.id),
    ).toEqual([CHUNKS_A[2]!.id, CHUNKS_A[0]!.id]);
    expect(
      sdk.dense.fetch.mock.calls
        .filter((call) => call[0] === DOC_A)
        .map((call) => call[1].ids.length),
    ).toEqual([1_000, 2]);
    expect(logUsage).toHaveBeenCalledWith({
      backend: 'pinecone',
      operation: 'fetch',
      usage: { ...ZERO_USAGE, readUnits: 1 },
    });
    expect(await backend.getChunks(DOC_A, [])).toEqual([]);
  });
  it('maps usage fields and logs only aggregate counts', async () => {
    const { backend, sdk, logUsage } = setup();
    await backend.ensureReady();
    sdk.dense.upsert.mockResolvedValueOnce({
      usage: { embed_total_tokens: 20, write_units: 2 },
    });
    sdk.sparse.upsert.mockResolvedValueOnce({
      usage: { embedTotalTokens: 10, writeUnits: 1 },
    });
    expect((await backend.upsertChunks(DOC_A, CHUNKS_A)).usage).toEqual({
      ...ZERO_USAGE,
      embedTokens: 30,
      writeUnits: 3,
    });
    sdk.dense.search.mockResolvedValueOnce({
      result: { hits: [] },
      usage: { embedTotalTokens: 7, readUnits: 2 },
    });
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'secret query',
          topK: 1,
        })
      ).usage,
    ).toEqual({ ...ZERO_USAGE, embedTokens: 7, readUnits: 2 });
    sdk.rerank.mockResolvedValueOnce({
      data: [{ index: 0, score: 1 }],
      usage: { rerank_units: 1 },
    });
    const chunk = fromRecord(CHUNKS_A[0]!.id, toRecord(CHUNKS_A[0]!), DOC_A);
    expect(
      (
        await backend.rerank({
          query: 'q',
          hits: [{ chunk, score: 0 }],
          topN: 9,
        })
      ).usage.rerankUnits,
    ).toBe(1);
    expect(JSON.stringify(logUsage.mock.calls)).not.toContain('secret query');
  });
  it('reranks by text and maps response positions back to intact original chunks', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    const hits = CHUNKS_A.slice(0, 3).map((c) => ({
      chunk: fromRecord(c.id, toRecord(c), DOC_A),
      score: 0,
    }));
    sdk.rerank.mockResolvedValueOnce({
      data: [
        { index: 2, score: 0.4 },
        { index: 0, score: 0.9 },
      ],
      usage: {},
    });
    const reranked = await backend.rerank({ query: 'town', hits, topN: 2 });
    expect(reranked.hits.map((hit) => hit.chunk)).toEqual([
      hits[0]!.chunk,
      hits[2]!.chunk,
    ]);
    expect(sdk.rerank).toHaveBeenCalledWith({
      model: defaults.rerankModel,
      query: 'town',
      documents: hits.map((hit) => ({
        id: hit.chunk.id,
        text: hit.chunk.text,
      })),
      rankFields: ['text'],
      topN: 2,
      returnDocuments: false,
      parameters: { truncate: 'END' },
    });
    expect(await backend.rerank({ query: 'q', hits: [], topN: 1 })).toEqual({
      hits: [],
      usage: ZERO_USAGE,
    });
  });
  it('cleans up partial first ingests and never reports a failed batch as done', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    sdk.sparse.upsert.mockRejectedValueOnce({ status: 429 });
    const progress = vi.fn();
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, progress),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(progress).not.toHaveBeenCalled();
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(await backend.hasDocument(DOC_A)).toBe(true);
  });
  it.each([7, 97])(
    'recovers %i chunks after sparse failure and failed cleanup, including a backend restart',
    async (count) => {
      const { backend, sdk } = setup();
      await backend.ensureReady();
      const chunks =
        count === 7
          ? CHUNKS_A
          : Array.from({ length: count }, (_, n) => ({
              ...CHUNKS_A[0]!,
              id: `${DOC_A}:sec-1:${String(n)}`,
            }));
      // For multiple batches, leave records in both indexes before the final sparse write fails.
      if (count > 96)
        sdk.sparse.upsert.mockImplementationOnce(
          sdk.sparse.upsert.getMockImplementation()!,
        );
      sdk.sparse.upsert.mockRejectedValueOnce({ status: 429 });
      sdk.dense.deleteNamespace
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('cleanup secret'));
      const progress = vi.fn<(p: UpsertProgress) => void>();
      await expect(
        backend.upsertChunks(DOC_A, chunks, progress),
      ).rejects.toMatchObject({
        code: 'RATE_LIMITED',
      });
      expect(progress.mock.calls.map(([p]) => p.done)).toEqual(
        count > 96 ? [96] : [],
      );
      expect(await backend.recordCounts(DOC_A)).toEqual([
        count,
        count > 96 ? 96 : 0,
      ]);
      expect(await backend.hasDocument(DOC_A)).toBe(false);

      const restarted = new PineconeBackend({
        client: sdk.client,
        config: defaults,
        logUsage: () => undefined,
      });
      await restarted.ensureReady();
      expect(await restarted.hasDocument(DOC_A)).toBe(false);
      await restarted.upsertChunks(DOC_A, chunks);
      expect(await restarted.recordCounts(DOC_A)).toEqual([count, count]);
      expect(await restarted.hasDocument(DOC_A)).toBe(true);

      const completedRestart = new PineconeBackend({
        client: sdk.client,
        config: defaults,
        logUsage: () => undefined,
      });
      await completedRestart.ensureReady();
      expect(await completedRestart.hasDocument(DOC_A)).toBe(true);
      await completedRestart.deleteDocument(DOC_A);
      expect(await restarted.hasDocument(DOC_A)).toBe(false);
    },
  );
  it('does not report completion when publishing the marker and cleaning up both fail', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    sdk.dense.upsert
      .mockImplementationOnce(sdk.dense.upsert.getMockImplementation()!)
      .mockRejectedValueOnce({ status: 429 });
    sdk.dense.deleteNamespace
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('cleanup secret'));
    await expect(backend.upsertChunks(DOC_A, CHUNKS_A)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(await backend.recordCounts(DOC_A)).toEqual([
      CHUNKS_A.length,
      CHUNKS_A.length,
    ]);
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    const restarted = new PineconeBackend({
      client: sdk.client,
      config: defaults,
      logUsage: () => undefined,
    });
    await restarted.ensureReady();
    expect(await restarted.hasDocument(DOC_A)).toBe(false);
    await restarted.upsertChunks(DOC_A, CHUNKS_A);
    expect(await restarted.hasDocument(DOC_A)).toBe(true);
  });
  it('invalidates completion before a deletion whose chunk cleanup fails', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    sdk.dense.deleteNamespace
      .mockImplementationOnce(
        sdk.dense.deleteNamespace.getMockImplementation()!,
      )
      .mockRejectedValueOnce(new Error('cleanup secret'));
    await expect(backend.deleteDocument(DOC_A)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    expect(await backend.recordCounts(DOC_A)).toEqual([
      CHUNKS_A.length,
      CHUNKS_A.length,
    ]);
    expect(await backend.hasDocument(DOC_A)).toBe(false);
  });
  it('validates chunks before writing, and treats empty writes as no-ops', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    await expect(backend.upsertChunks(DOC_B, CHUNKS_A)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(
      backend.upsertChunks(DOC_B, [{ ...CHUNKS_B[0]!, text: '' }]),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(await backend.upsertChunks(DOC_B, [])).toEqual({
      usage: ZERO_USAGE,
    });
    expect(sdk.dense.deleteNamespace).not.toHaveBeenCalled();
  });
  it('handles absent completion records and idempotent not-found on deletion/search/fetch', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    sdk.dense.fetch.mockRejectedValueOnce({ status: 404 });
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    sdk.dense.deleteNamespace.mockRejectedValueOnce({ status: 404 });
    sdk.sparse.deleteNamespace.mockRejectedValueOnce(
      new Errors.PineconeNotFoundError({ url: 'url', status: 404 }),
    );
    await backend.deleteDocument(DOC_A);
    sdk.dense.search.mockRejectedValueOnce({ status: 404 });
    expect(
      (
        await backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'q',
          topK: 1,
        })
      ).hits,
    ).toEqual([]);
    sdk.dense.fetch.mockRejectedValueOnce({ status: 404 });
    expect(await backend.getChunks(DOC_A, ['missing'])).toEqual([]);
    sdk.dense.fetch.mockRejectedValueOnce({ status: 401 });
    await expect(backend.getChunks(DOC_A, ['missing'])).rejects.toMatchObject({
      code: 'MISSING_KEY',
    });
  });
  it.each([
    [{ status: 401, message: 'secret-key' }, 'MISSING_KEY'],
    [
      new Errors.PineconeAuthorizationError({
        status: 401,
        body: 'secret-key',
      }),
      'MISSING_KEY',
    ],
    [{ status: 429, message: 'secret-key' }, 'RATE_LIMITED'],
    [
      new Errors.PineconeUnmappedHttpError({ status: 429, body: 'secret-key' }),
      'RATE_LIMITED',
    ],
    [new Error('network secret-key'), 'BACKEND_UNAVAILABLE'],
    [null, 'BACKEND_UNAVAILABLE'],
  ])(
    'maps SDK errors and drops all raw detail and causes',
    async (error, code) => {
      const { backend, sdk, logUsage } = setup();
      await backend.ensureReady();
      sdk.dense.search.mockRejectedValueOnce(error);
      const failure: unknown = await backend
        .search({ docId: DOC_A, index: 'dense', query: 'q', topK: 1 })
        .catch((caught: unknown) => caught);
      expect(failure).toBeInstanceOf(AppError);
      expect(failure).toMatchObject({
        code,
        cause: undefined,
        details: undefined,
      });
      expect(String(failure)).not.toContain('secret-key');
      expect(JSON.stringify(failure)).not.toContain('secret-key');
      expect(JSON.stringify(logUsage.mock.calls)).not.toContain('secret-key');
    },
  );
  it('requires a key only when no client is injected, and requires readiness', async () => {
    expect(() => new PineconeBackend({ apiKey: '' })).toThrow(
      'API key is missing',
    );
    // Client construction performs no network request.
    expect(new PineconeBackend({ apiKey: 'synthetic-test-key' }).kind).toBe(
      'pinecone',
    );
    const { backend } = setup();
    await expect(backend.hasDocument(DOC_A)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
  });
  it('checks abort before network calls and while polling without leaking abort reasons', async () => {
    const { backend, sdk } = setup();
    const signal = AbortSignal.abort('secret-key');
    await expect(backend.ensureReady(signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sdk.create).not.toHaveBeenCalled();
    await backend.ensureReady();
    await expect(
      backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'q',
        topK: 1,
        signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      backend.rerank({ query: 'q', hits: [], topN: 1, signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(settle(backend, DOC_A, 0, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    sdk.dense.search.mockImplementationOnce(async () => {
      await Promise.resolve();
      during.abort('secret-key');
      return {};
    });
    await expect(
      backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'q',
        topK: 1,
        signal: during.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('settles only when both namespaces match, including deletion and timeouts', async () => {
    const { backend, sdk } = setup({ timeoutMs: 3 });
    await backend.ensureReady();
    sdk.sparse.describeIndexStats.mockResolvedValueOnce({});
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    await settle(backend, DOC_A, CHUNKS_A.length);
    expect(sdk.sparse.describeIndexStats).toHaveBeenCalledTimes(2);
    await expect(settle(backend, DOC_A, 99)).rejects.toThrow('did not settle');
    await backend.deleteDocument(DOC_A);
    await backend.settle();
    const controller = new AbortController();
    const waiting = settle(backend, DOC_A, 99, controller.signal);
    controller.abort('secret-key');
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('rejects invalid request bounds and corrupt backend output', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    for (const topK of [0, -1, 1.5, 10_001])
      await expect(
        backend.search({ docId: DOC_A, index: 'dense', query: 'q', topK }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      backend.rerank({ query: 'q', hits: [], topN: 0 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const chunk = fromRecord(CHUNKS_A[0]!.id, toRecord(CHUNKS_A[0]!), DOC_A);
    const hits = [{ chunk, score: 0 }];
    await expect(
      backend.rerank({
        query: 'q',
        hits: Array.from({ length: 101 }, () => hits[0]!),
        topN: 1,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    for (const data of [
      [{ index: 99, score: 1 }],
      [
        { index: 0, score: 1 },
        { index: 0, score: 0 },
      ],
      [],
    ]) {
      sdk.rerank.mockResolvedValueOnce({ data });
      await expect(
        backend.rerank({ query: 'q', hits, topN: 1 }),
      ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    }
    sdk.dense.search.mockResolvedValueOnce({
      result: { hits: [{ _id: 'bad', _score: 1, fields: {} }] },
    });
    await expect(
      backend.search({ docId: DOC_A, index: 'dense', query: 'q', topK: 1 }),
    ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    sdk.dense.fetch.mockResolvedValueOnce({
      records: { id: { id: 'other', metadata: {} } },
    });
    await expect(backend.getChunks(DOC_A, ['id'])).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    sdk.dense.fetch.mockResolvedValueOnce({
      records: { id: { id: 'id', metadata: {} } },
    });
    await expect(backend.getChunks(DOC_A, ['id'])).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
  });
  it('sorts search responses by descending score and honors topK defensively', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    sdk.dense.search.mockResolvedValueOnce({
      result: {
        hits: CHUNKS_A.slice(0, 3).map((chunk, n) => ({
          _id: chunk.id,
          _score: n,
          fields: toRecord(chunk),
        })),
      },
    });
    const { hits } = await backend.search({
      docId: DOC_A,
      index: 'dense',
      query: 'q',
      topK: 2,
      filter: {},
    });
    expect(hits.map((hit) => hit.score)).toEqual([2, 1]);
  });
  it('keeps existing chunks after a failed re-upsert, invalidates completion, and sanitizes cleanup errors', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    sdk.sparse.upsert.mockRejectedValueOnce(new Error('network'));
    await expect(backend.upsertChunks(DOC_A, CHUNKS_A)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    expect(
      await backend.getChunks(
        DOC_A,
        CHUNKS_A.map((chunk) => chunk.id),
      ),
    ).toHaveLength(CHUNKS_A.length);
    sdk.sparse.upsert.mockRejectedValueOnce({ status: 429 });
    sdk.dense.deleteNamespace.mockRejectedValueOnce(
      new Error('cleanup secret'),
    );
    await expect(backend.upsertChunks(DOC_B, CHUNKS_B)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});
