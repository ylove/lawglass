import { Errors } from '@pinecone-database/pinecone';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeBackendContract } from '../../../../tests/contracts/backend.contract.js';
import { fakePineconeClient as fakeSdk } from '../../../../tests/contracts/fake-pinecone-client.js';
import {
  CHUNKS_A,
  CHUNKS_B,
  DOC_A,
  DOC_B,
} from '../../../../tests/contracts/sample-chunks.js';
import { BRAND } from '../../brand.js';
import { estimateTokens } from '../../chunk/tokens.js';
import { pineconeConfig } from '../../config.js';
import {
  AppError,
  ZERO_USAGE,
  type UpsertProgress,
} from '../../model/index.js';
import { fromRecord, toRecord } from './metadata.js';
import {
  PineconeBackend,
  settle,
  type PineconeBackendOptions,
} from './pinecone.js';

const defaults = pineconeConfig({}, {});

afterEach(() => {
  vi.restoreAllMocks();
});
function setup(
  config: Parameters<typeof pineconeConfig>[0] = {},
  timing: Pick<PineconeBackendOptions, 'now' | 'sleep'> = {},
) {
  const sdk = fakeSdk();
  const logUsage = vi.fn<NonNullable<PineconeBackendOptions['logUsage']>>();
  let timeMs = 0;
  const sleep = vi.fn((ms: number, signal?: AbortSignal) => {
    if (signal?.aborted)
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    timeMs += ms;
    return Promise.resolve();
  });
  const backend = new PineconeBackend({
    client: sdk.client,
    logUsage,
    config: { ...defaults, pollIntervalMs: 1, timeoutMs: 20, ...config },
    now: () => timeMs,
    random: () => 0.5,
    sleep,
    ...timing,
  });
  return { backend, sdk, logUsage, sleep };
}

type RetriedOperation = 'upsert' | 'search' | 'rerank';
async function retrySetup(
  operation: RetriedOperation,
  config: Parameters<typeof pineconeConfig>[0] = {},
  timing: Pick<PineconeBackendOptions, 'now' | 'sleep'> = {},
) {
  const state = setup(config, timing);
  const { backend, sdk } = state;
  await backend.ensureReady();
  if (operation !== 'upsert') await backend.upsertChunks(DOC_A, CHUNKS_A);
  const mock =
    operation === 'upsert'
      ? sdk.sparse.upsert
      : operation === 'search'
        ? sdk.dense.search
        : sdk.rerank;
  mock.mockClear();
  state.logUsage.mockClear();
  state.sleep.mockClear();
  const run = (signal?: AbortSignal) => {
    if (operation === 'upsert')
      return backend.upsertChunks(DOC_A, CHUNKS_A, undefined, signal);
    if (operation === 'search')
      return backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'town',
        topK: 2,
        signal,
      });
    return backend.rerank({
      query: 'town',
      hits: CHUNKS_A.slice(0, 2).map((chunk) => ({ chunk, score: 1 })),
      topN: 1,
      signal,
    });
  };
  return { ...state, mock, run };
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
  describe('rate-limit retries', () => {
    it.each(['upsert', 'search', 'rerank'] as const)(
      'retries %s with exponential jittered waits and reports only successful usage',
      async (operation) => {
        const { mock, run, sleep, logUsage } = await retrySetup(operation);
        mock
          .mockRejectedValueOnce({ status: 429, message: 'secret-key' })
          .mockRejectedValueOnce({
            name: 'PineconeRateLimitError',
            message: 'secret-key',
          })
          .mockRejectedValueOnce(
            new Errors.PineconeUnmappedHttpError({
              status: 429,
              body: 'secret-key',
            }),
          );
        await expect(run()).resolves.toHaveProperty('usage');
        // A multi-record upsert batch is halved on its third 429 instead of waiting again.
        expect(mock).toHaveBeenCalledTimes(operation === 'upsert' ? 5 : 4);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
          operation === 'upsert' ? [1_000, 2_000] : [1_000, 2_000, 4_000],
        );
        expect(logUsage.mock.calls).toHaveLength(
          operation === 'upsert' ? 6 : 1,
        );
        expect(JSON.stringify(logUsage.mock.calls)).not.toContain('secret-key');
      },
    );
    it.each(['upsert', 'search', 'rerank'] as const)(
      'bounds the total %s retry time and sanitizes the error',
      async (operation) => {
        const { mock, run, sleep } = await retrySetup(operation, {
          upsertRetryBudgetMs: 2_500,
          queryRetryBudgetMs: 2_500,
        });
        mock.mockRejectedValue({ status: 429, message: 'secret-key' });
        const error: unknown = await run().catch((error: unknown) => error);
        expect(error).toMatchObject({
          code: 'RATE_LIMITED',
          cause: undefined,
        });
        expect((error as AppError).userMessage).toMatch(
          /Starter tier.*retry later/,
        );
        expect(mock).toHaveBeenCalledTimes(2);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 1_500]);
        expect(String(error) + JSON.stringify(error)).not.toContain(
          'secret-key',
        );
      },
    );
    it.each(['upsert', 'search', 'rerank'] as const)(
      'aborts %s during a retry wait without another request',
      async (operation) => {
        const controller = new AbortController();
        const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
          expect(signal).toBe(controller.signal);
          controller.abort('secret-key');
          return Promise.resolve();
        });
        const { mock, run } = await retrySetup(operation, {}, { sleep });
        mock.mockRejectedValue({ status: 429 });
        await expect(run(controller.signal)).rejects.toMatchObject({
          name: 'AbortError',
          message: 'The operation was aborted.',
        });
        expect(mock).toHaveBeenCalledTimes(1);
        expect(sleep).toHaveBeenCalledTimes(1);
      },
    );
    it.each(['upsert', 'search', 'rerank'] as const)(
      'aborts %s while the SDK request is in flight',
      async (operation) => {
        const controller = new AbortController();
        const { mock, run } = await retrySetup(operation);
        mock.mockImplementationOnce(() => {
          controller.abort('secret-key');
          return new Promise<never>(() => undefined);
        });
        await expect(run(controller.signal)).rejects.toMatchObject({
          name: 'AbortError',
          message: 'The operation was aborted.',
        });
        expect(mock).toHaveBeenCalledTimes(1);
      },
    );
    it.each([
      { retryAfter: 3 },
      { headers: { 'Retry-After': '3' } },
      { response: { headers: new Headers({ 'retry-after': '3' }) } },
      { headers: { 'retry-after': new Date(3_000).toUTCString() } },
    ])('honors retry-after in the exposed SDK error: %j', async (fields) => {
      const { mock, run, sleep } = await retrySetup('search');
      mock.mockRejectedValueOnce({ status: 429, ...fields });
      await run();
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([3_000]);
    });
    it('handles synchronous SDK failure during abort without an unhandled rejection', async () => {
      const controller = new AbortController();
      const { mock, run } = await retrySetup('search');
      mock.mockImplementationOnce(() => {
        controller.abort('secret-key');
        throw new Error('secret-key');
      });
      await expect(run(controller.signal)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'The operation was aborted.',
      });
      expect(mock).toHaveBeenCalledTimes(1);
    });
    it.each(['secret-key', '-1', Infinity, {}])(
      'ignores invalid retry-after values: %j',
      async (retryAfter) => {
        const { mock, run, sleep } = await retrySetup('search');
        mock.mockRejectedValueOnce({ status: 429, retryAfter });
        await run();
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000]);
      },
    );
    it('honors a long retry-after without any single wait exceeding 30 seconds', async () => {
      const { mock, run, sleep } = await retrySetup('search', {
        queryRetryBudgetMs: 90_000,
      });
      mock.mockRejectedValueOnce({
        status: 429,
        headers: { 'retry-after': '70' },
      });
      await run();
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([
        30_000, 30_000, 10_000,
      ]);
      expect(mock).toHaveBeenCalledTimes(2);
    });
    it('stops at the budget when retry-after exceeds it', async () => {
      const { mock, run, sleep } = await retrySetup('search');
      mock.mockRejectedValueOnce({ status: 429, retryAfter: 120 });
      await expect(run()).rejects.toMatchObject({ code: 'RATE_LIMITED' });
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([30_000, 30_000]);
      expect(mock).toHaveBeenCalledTimes(1);
    });
    it('caps exponential waits and applies jitter', async () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.75);
      // Use the production random source while retaining a simulated clock.
      const sdk = fakeSdk();
      let time = 0;
      const waits: number[] = [];
      const backend = new PineconeBackend({
        client: sdk.client,
        config: { ...defaults, queryRetryBudgetMs: 300_000 },
        logUsage: () => undefined,
        now: () => time,
        sleep: (ms) => {
          waits.push(ms);
          time += ms;
          return Promise.resolve();
        },
      });
      for (let n = 0; n < 8; n++)
        sdk.dense.search.mockRejectedValueOnce({ status: 429 });
      await backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'q',
        topK: 1,
      });
      expect(waits).toEqual([
        1_250, 2_500, 5_000, 10_000, 20_000, 30_000, 30_000, 30_000,
      ]);
      expect(random).toHaveBeenCalledTimes(8);
    });
    it.each([7, 97, 193])(
      'paces only between batches for %i chunks when configured',
      async (count) => {
        const { backend, sleep } = setup({ upsertBatchDelayMs: 50 });
        const chunks = Array.from({ length: count }, (_, n) => ({
          ...CHUNKS_A[0]!,
          id: `${DOC_A}:sec-1:${String(n)}`,
        }));
        await backend.upsertChunks(DOC_A, chunks);
        expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
          Array.from({ length: Math.ceil(count / 96) - 1 }, () => 50),
        );
      },
    );
    describe('token-budgeted batches', () => {
      const wordy = (n: number, words: number) => ({
        ...CHUNKS_A[0]!,
        id: `${DOC_A}:sec-1:${String(n)}`,
        embedText: Array.from({ length: words }, () => 'word').join(' '),
      });
      const batchSizes = (mock: { mock: { calls: unknown[][] } }) =>
        mock.mock.calls.map(
          ([, options]) => (options as { records: unknown[] }).records.length,
        );
      it('splits batches at the configured token cap', async () => {
        // 100 words is about 130 estimated tokens, so 300 allows two records per batch.
        const { backend, sdk } = setup({ upsertMaxBatchTokens: 300 });
        await backend.upsertChunks(
          DOC_A,
          Array.from({ length: 5 }, (_, n) => wordy(n, 100)),
        );
        expect(batchSizes(sdk.dense.upsert).slice(0, 3)).toEqual([2, 2, 1]);
      });
      it('reads the cap from the environment', () => {
        expect(
          pineconeConfig(
            {},
            { LAWGLASS_PINECONE_UPSERT_MAX_BATCH_TOKENS: '1234' },
          ).upsertMaxBatchTokens,
        ).toBe(1234);
        expect(defaults.upsertMaxBatchTokens).toBe(20_000);
      });
      it('sends an over-cap record alone instead of dropping it', async () => {
        const { backend, sdk } = setup({ upsertMaxBatchTokens: 10 });
        await backend.upsertChunks(DOC_A, [wordy(0, 100), wordy(1, 100)]);
        expect(batchSizes(sdk.dense.upsert).slice(0, 2)).toEqual([1, 1]);
      });
      it('halves a batch the tier keeps rejecting until the ingest completes', async () => {
        const { backend, sdk } = setup({ upsertMaxBatchTokens: 1_000_000 });
        const limit = 400;
        const tokensOf = (options: unknown) =>
          (options as { records: { embed_text: string }[] }).records.reduce(
            (sum, r) => sum + estimateTokens(r.embed_text),
            0,
          );
        for (const mock of [sdk.dense.upsert, sdk.sparse.upsert]) {
          const ok = mock.getMockImplementation();
          mock.mockImplementation((docId, options) =>
            tokensOf(options) > limit
              ? Promise.reject(Object.assign(new Error('429'), { status: 429 }))
              : (ok?.(docId, options) ?? Promise.resolve()),
          );
        }
        const chunks = Array.from({ length: 8 }, (_, n) => wordy(n, 100));
        await expect(
          backend.upsertChunks(DOC_A, chunks),
        ).resolves.toBeDefined();
        const accepted = [sdk.dense.upsert, sdk.sparse.upsert].map((mock) =>
          mock.mock.calls
            .map(([, o]) => o as { records: unknown[] })
            .filter((o) => tokensOf(o) <= limit)
            .reduce((n, o) => n + o.records.length, 0),
        );
        // 8 chunk records plus the completion marker (dense only).
        expect(accepted).toEqual([9, 8]);
      });
      it('falls back to one record and then applies the retry budget', async () => {
        const { backend, sdk } = setup({ upsertRetryBudgetMs: 5_000 });
        sdk.dense.upsert.mockRejectedValue({ status: 429 });
        await expect(
          backend.upsertChunks(DOC_A, [wordy(0, 5), wordy(1, 5)]),
        ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
        expect(batchSizes(sdk.dense.upsert)).toEqual([2, 2, 2, 1, 1, 1]);
      });
      it('aborts while splitting', async () => {
        const controller = new AbortController();
        const { backend, sdk } = setup();
        sdk.dense.upsert.mockImplementation(() => {
          controller.abort();
          return Promise.reject(
            Object.assign(new Error('429'), { status: 429 }),
          );
        });
        await expect(
          backend.upsertChunks(
            DOC_A,
            [wordy(0, 5), wordy(1, 5)],
            undefined,
            controller.signal,
          ),
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(sdk.dense.upsert).toHaveBeenCalledTimes(1);
      });
    });
    it('enforces the query budget even when a retry request never settles', async () => {
      vi.useFakeTimers();
      try {
        const sdk = fakeSdk();
        const backend = new PineconeBackend({
          client: sdk.client,
          config: { ...defaults, queryRetryBudgetMs: 2_000 },
          logUsage: () => undefined,
          now: Date.now,
          random: () => 0.5,
          sleep: (ms) =>
            new Promise((resolve) => {
              setTimeout(resolve, ms);
            }),
        });
        sdk.dense.search
          .mockRejectedValueOnce({ status: 429 })
          .mockImplementationOnce(() => new Promise<never>(() => undefined));
        const result = backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'q',
          topK: 1,
        });
        const rejected = expect(result).rejects.toMatchObject({
          code: 'RATE_LIMITED',
        });
        await vi.advanceTimersByTimeAsync(2_000);
        await rejected;
        expect(sdk.dense.search).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
    it('retries dense chunk writes and the completion marker before declaring completion', async () => {
      const { backend, sdk, sleep } = setup();
      const write = sdk.dense.upsert.getMockImplementation()!;
      sdk.dense.upsert
        .mockRejectedValueOnce({ status: 429 })
        .mockImplementationOnce(write)
        .mockRejectedValueOnce({ status: 429 });
      await backend.upsertChunks(DOC_A, CHUNKS_A);
      expect(sdk.dense.upsert).toHaveBeenCalledTimes(4);
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 1_000]);
      expect(await backend.hasDocument(DOC_A)).toBe(true);
    });
    it('retries sparse searches too', async () => {
      const { backend, sdk } = setup();
      sdk.sparse.search.mockRejectedValueOnce({ status: 429 });
      await backend.search({
        docId: DOC_A,
        index: 'sparse',
        query: 'q',
        topK: 1,
      });
      expect(sdk.sparse.search).toHaveBeenCalledTimes(2);
    });
    it.each([401, 404, 500])(
      'does not retry other HTTP statuses: %i',
      async (status) => {
        const { mock, run, sleep } = await retrySetup('search');
        mock.mockRejectedValueOnce({ status, message: 'secret-key' });
        if (status === 404)
          await expect(run()).resolves.toEqual({ hits: [], usage: ZERO_USAGE });
        else
          await expect(run()).rejects.toMatchObject({
            code: status === 401 ? 'MISSING_KEY' : 'BACKEND_UNAVAILABLE',
          });
        expect(mock).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
      },
    );
  });
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
  it('checks documents on a fresh backend and shares initialization with ensureReady', async () => {
    const { backend, sdk } = setup();
    await expect(backend.hasDocument(DOC_A)).resolves.toBe(false);
    await Promise.all([backend.hasDocument(DOC_B), backend.ensureReady()]);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });
  it('deletes documents on a fresh backend without ensureReady', async () => {
    const { sdk } = setup();
    const writer = new PineconeBackend({
      client: sdk.client,
      logUsage: () => undefined,
    });
    await writer.ensureReady();
    await writer.upsertChunks(DOC_A, CHUNKS_A);
    sdk.create.mockClear();
    const fresh = new PineconeBackend({
      client: sdk.client,
      logUsage: () => undefined,
    });
    await fresh.deleteDocument(DOC_A);
    expect(await writer.hasDocument(DOC_A)).toBe(false);
    expect(await writer.recordCounts(DOC_A)).toEqual([0, 0]);
    expect(sdk.create).toHaveBeenCalledTimes(2);
  });
  it('retries a failed lazy initialization on the next method call', async () => {
    const { backend, sdk } = setup();
    sdk.create.mockRejectedValueOnce(new Error('network'));
    await expect(backend.hasDocument(DOC_A)).rejects.toMatchObject({
      code: 'BACKEND_UNAVAILABLE',
    });
    await backend.deleteDocument(DOC_A);
    expect(sdk.create).toHaveBeenCalledTimes(3);
    await backend.ensureReady();
    expect(sdk.create).toHaveBeenCalledTimes(3);
  });
  it.each(['upsert', 'search', 'fetch', 'rerank', 'counts', 'settle'] as const)(
    'initializes lazily for %s and reuses the same indexes',
    async (operation) => {
      const { backend, sdk } = setup();
      switch (operation) {
        case 'upsert':
          await backend.upsertChunks(DOC_A, CHUNKS_A);
          expect(sdk.dense.upsert).toHaveBeenCalled();
          break;
        case 'search':
          await expect(
            backend.search({
              docId: DOC_A,
              index: 'dense',
              query: 'garden',
              topK: 1,
            }),
          ).resolves.toMatchObject({ hits: [] });
          break;
        case 'fetch':
          await expect(backend.getChunks(DOC_A, ['missing'])).resolves.toEqual(
            [],
          );
          break;
        case 'rerank':
          // These hits can come from another backend instance, outside the fake's store.
          sdk.rerank.mockResolvedValueOnce({ data: [{ index: 0, score: 1 }] });
          await backend.rerank({
            query: 'garden',
            hits: [{ chunk: CHUNKS_A[0]!, score: 1 }],
            topN: 1,
          });
          expect(sdk.rerank).toHaveBeenCalled();
          break;
        case 'counts':
          await expect(backend.recordCounts(DOC_A)).resolves.toEqual([0, 0]);
          break;
        case 'settle':
          await backend.settle();
          break;
      }
      expect(sdk.create).toHaveBeenCalledTimes(2);
      await backend.ensureReady();
      expect(sdk.create).toHaveBeenCalledTimes(2);
    },
  );
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
    const { backend, sdk, logUsage, sleep } = setup();
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
    expect(logUsage).toHaveBeenCalledTimes(9);
    expect(sleep).not.toHaveBeenCalled();
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
  it.each(['upsert', 'delete'] as const)(
    'waits for eventual completion-marker visibility after %s',
    async (operation) => {
      const { backend, sdk, sleep } = setup({ timeoutMs: 10_000 });
      await backend.ensureReady();
      if (operation === 'upsert') {
        sdk.dense.consistency.upsertReads = 3;
        await backend.upsertChunks(DOC_A, CHUNKS_A);
      } else {
        await backend.upsertChunks(DOC_A, CHUNKS_A);
        sdk.dense.consistency.deleteReads = 3;
        await backend.deleteDocument(DOC_A);
      }
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([250, 500, 1_000]);
      expect(await backend.hasDocument(DOC_A)).toBe(operation === 'upsert');
      expect(await backend.recordCounts(DOC_A)).toEqual(
        operation === 'upsert' ? [CHUNKS_A.length, CHUNKS_A.length] : [0, 0],
      );
    },
  );
  it.each([
    ['upsert', 20_000],
    ['delete', 20_000],
    ['upsert', 600],
    ['delete', 600],
  ] as const)(
    'returns after bounded polling on %s with timeoutMs=%i, preserving the successful write',
    async (operation, timeoutMs) => {
      const { backend, sdk, sleep, logUsage } = setup({ timeoutMs });
      await backend.ensureReady();
      if (operation === 'upsert') {
        sdk.dense.consistency.upsertReads = Infinity;
        await expect(backend.upsertChunks(DOC_A, CHUNKS_A)).resolves.toEqual({
          usage: ZERO_USAGE,
        });
        expect(sdk.dense.deleteNamespace).not.toHaveBeenCalled();
      } else {
        await backend.upsertChunks(DOC_A, CHUNKS_A);
        sdk.dense.consistency.deleteReads = Infinity;
        await expect(backend.deleteDocument(DOC_A)).resolves.toBeUndefined();
      }
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual(
        timeoutMs === 600 ? [250, 350] : [250, 500, 1_000, 2_000, 4_000, 2_250],
      );
      expect(await backend.hasDocument(DOC_A)).toBe(operation === 'delete');
      expect(await backend.recordCounts(DOC_A)).toEqual(
        operation === 'upsert' ? [CHUNKS_A.length, CHUNKS_A.length] : [0, 0],
      );
      // Polling and its timeout emit only the existing aggregate usage events.
      for (const [event] of logUsage.mock.calls)
        expect(Object.keys(event).sort()).toEqual([
          'backend',
          'operation',
          'usage',
        ]);
    },
  );
  it.each(['upsert', 'delete'] as const)(
    'honours abort during %s polling without rolling back the write or exposing the reason',
    async (operation) => {
      const controller = new AbortController();
      const sleep = vi.fn((_ms: number, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal);
        controller.abort('secret-key');
        return Promise.reject(new DOMException('Aborted', 'AbortError'));
      });
      const { backend, sdk, logUsage } = setup(
        { timeoutMs: 10_000 },
        { sleep },
      );
      await backend.ensureReady();
      if (operation === 'delete') await backend.upsertChunks(DOC_A, CHUNKS_A);
      sdk.dense.consistency.upsertReads = Infinity;
      sdk.dense.consistency.deleteReads = Infinity;
      const writing =
        operation === 'upsert'
          ? backend.upsertChunks(DOC_A, CHUNKS_A, undefined, controller.signal)
          : backend.deleteDocument(DOC_A, controller.signal);
      const error: unknown = await writing.catch((caught: unknown) => caught);
      expect(error).toMatchObject({ name: 'AbortError' });
      expect(String(error)).not.toContain('secret-key');
      expect(JSON.stringify(logUsage.mock.calls)).not.toContain('secret-key');
      expect(sleep).toHaveBeenCalledTimes(1);
      expect(await backend.recordCounts(DOC_A)).toEqual(
        operation === 'upsert' ? [CHUNKS_A.length, CHUNKS_A.length] : [0, 0],
      );
      if (operation === 'upsert')
        expect(sdk.dense.deleteNamespace).not.toHaveBeenCalled();
    },
  );
  it('keeps the completion namespace within the documented 512 ASCII character limit', async () => {
    const { backend, sdk } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const namespace = sdk.dense.upsert.mock.calls.find(
      ([, options]) => options.records[0]?._id === 'complete',
    )?.[0];
    expect(namespace).toBe(`ingest-complete:${DOC_A}`);
    expect(namespace).toHaveLength(80);
    expect(Buffer.byteLength(namespace!)).toBe(namespace!.length);
    expect(namespace!.length).toBeLessThanOrEqual(512);
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
        text: `${hit.chunk.breadcrumb}: ${hit.chunk.text}`,
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
    const { backend, sdk } = setup({ upsertRetryBudgetMs: 1 });
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
      const { backend, sdk } = setup({ upsertRetryBudgetMs: 1 });
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
    const { backend, sdk } = setup({ upsertRetryBudgetMs: 1 });
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
      const { backend, sdk, logUsage } = setup({ queryRetryBudgetMs: 1 });
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
  it('explains a rejected Pinecone key without retaining key material', async () => {
    const { backend, sdk } = setup();
    sdk.create.mockRejectedValueOnce(
      Object.assign(new Error('secret-key'), { status: 401 }),
    );
    const error: unknown = await backend
      .ensureReady()
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'MISSING_KEY',
      userMessage:
        'Pinecone rejected the API key in PINECONE_API_KEY (or your saved config). Check it and try again.',
      cause: undefined,
    });
    expect(String(error)).not.toContain('missing');
    expect(String(error)).not.toContain('secret-key');
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });
  it('requires a key only when no client is injected', () => {
    expect(() => new PineconeBackend({ apiKey: '' })).toThrow(
      'API key is missing',
    );
    // Client construction performs no network request.
    expect(new PineconeBackend({ apiKey: 'synthetic-test-key' }).kind).toBe(
      'pinecone',
    );
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
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await expect(backend.deleteDocument(DOC_A, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(sdk.dense.upsert).not.toHaveBeenCalled();
    expect(sdk.dense.deleteNamespace).not.toHaveBeenCalled();
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
    // A long timeout, so only the abort can end the wait: with 3 ms the deadline can win under
    // load and the wait rejects with "did not settle" instead.
    const patient = setup({ timeoutMs: 60_000 });
    await patient.backend.ensureReady();
    const controller = new AbortController();
    const waiting = settle(patient.backend, DOC_A, 99, controller.signal);
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
    const { backend, sdk } = setup({ upsertRetryBudgetMs: 1 });
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
