/** Billed backend requests under a host's per-call gate (issue #435). */
import { describe, expect, it } from 'vitest';
import { fakePineconeClient as fakeSdk } from '../../../../tests/contracts/fake-pinecone-client.js';
import { CHUNKS_A, DOC_A } from '../../../../tests/contracts/sample-chunks.js';
import { pineconeConfig } from '../../config.js';
import {
  newSpend,
  runInJob,
  type CallEnd,
  type GateCall,
  type JobScope,
} from '../../cost/index.js';
import { PineconeBackend } from './pinecone.js';

function setup(prices?: JobScope['prices']) {
  const sdk = fakeSdk();
  let time = 0;
  const backend = new PineconeBackend({
    client: sdk.client,
    config: { ...pineconeConfig({}, {}), pollIntervalMs: 1, timeoutMs: 20 },
    logUsage: () => undefined,
    now: () => time,
    random: () => 0.5,
    sleep: (ms) => {
      time += ms;
      return Promise.resolve();
    },
  });
  const calls: GateCall[] = [];
  const ends: CallEnd[] = [];
  let allow = true;
  const job: JobScope = {
    context: {
      readerId: 'a',
      jobKind: 'ingest',
      jobId: 'j',
      ref: 'hold-1',
      docId: DOC_A,
    },
    spent: newSpend(),
    ...(prices ? { prices } : {}),
    callGate: (c) => {
      calls.push(c);
      return allow;
    },
    onCallEnd: (e) => {
      ends.push(e);
    },
  };
  return { backend, sdk, job, calls, ends, deny: () => (allow = false) };
}

describe('Pinecone integrated inference under a call gate', () => {
  it('gates each embedding write, query and rerank with its own id, and ends each once', async () => {
    const { backend, job, calls, ends } = setup();
    await backend.ensureReady();
    await runInJob(job, async () => {
      await backend.upsertChunks(DOC_A, CHUNKS_A);
      await backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'town',
        topK: 2,
      });
      await backend.rerank({
        query: 'town',
        hits: CHUNKS_A.slice(0, 2).map((chunk) => ({ chunk, score: 1 })),
        topN: 1,
      });
    });
    const models = new Set(calls.map((c) => c.model));
    expect(calls.length).toBeGreaterThanOrEqual(5);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(calls.length);
    expect(models.size).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.ref === 'hold-1' && c.docId === DOC_A)).toBe(
      true,
    );
    // Pinecone bills in units and per request: always Infinity, a host applies its own policy.
    expect(
      calls.every((c) => c.worstCaseUsd === Number.POSITIVE_INFINITY),
    ).toBe(true);
    expect(ends.map((e) => e.callId)).toEqual(calls.map((c) => c.callId));
    expect(ends.every((e) => !e.reported)).toBe(true);
  });

  it('is Infinity even when the price table names the model: units and per-request billing have no rate bound', async () => {
    const config = pineconeConfig({}, {});
    const rate = { input: 2, output: 0, cacheRead: 0, cacheWrite: 0 };
    const { backend, job, calls } = setup({ [config.rerankModel]: rate });
    await backend.ensureReady();
    await runInJob(job, async () => {
      await backend.upsertChunks(DOC_A, CHUNKS_A);
      calls.length = 0;
      await backend.rerank({
        query: 'town',
        hits: CHUNKS_A.slice(0, 2).map((chunk) => ({ chunk, score: 1 })),
        topN: 1,
      });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe(config.rerankModel);
    expect(calls[0]?.worstCaseUsd).toBe(Number.POSITIVE_INFINITY);
  });

  it('gates the billed reads: completion checks, chunk fetches and index stats', async () => {
    const { backend, job, calls, ends } = setup();
    await backend.ensureReady();
    await runInJob(job, () => backend.upsertChunks(DOC_A, CHUNKS_A));
    calls.length = 0;
    ends.length = 0;
    await runInJob(job, async () => {
      await backend.hasDocument(DOC_A);
      await backend.getChunks(DOC_A, [CHUNKS_A[0]!.id]);
      await backend.recordCounts(DOC_A);
    });
    // One completion fetch, one chunk fetch, one stats call per index (dense and sparse).
    expect(calls).toHaveLength(4);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(4);
    expect(ends).toHaveLength(4);
  });

  it('a refusing gate stops reads before any SDK call', async () => {
    const { backend, sdk, job, deny } = setup();
    await backend.ensureReady();
    await runInJob(job, () => backend.upsertChunks(DOC_A, CHUNKS_A));
    deny();
    sdk.dense.fetch.mockClear();
    await expect(
      runInJob(job, () => backend.getChunks(DOC_A, [CHUNKS_A[0]!.id])),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(sdk.dense.fetch).not.toHaveBeenCalled();
  });

  it('each 429 retry is a new billed attempt and is gated again', async () => {
    const { backend, sdk, job, calls, ends } = setup();
    await backend.ensureReady();
    await runInJob(job, () => backend.upsertChunks(DOC_A, CHUNKS_A));
    calls.length = 0;
    ends.length = 0;
    sdk.dense.search.mockRejectedValueOnce({ status: 429 });
    await runInJob(job, () =>
      backend.search({ docId: DOC_A, index: 'dense', query: 'town', topK: 2 }),
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls.map((c) => c.callId)).size).toBe(2);
    expect(ends).toHaveLength(2);
  });

  it('a refusing gate stops the request before any SDK call', async () => {
    const { backend, sdk, job, deny } = setup();
    await backend.ensureReady();
    deny();
    sdk.dense.upsert.mockClear();
    sdk.sparse.upsert.mockClear();
    await expect(
      runInJob(job, () => backend.upsertChunks(DOC_A, CHUNKS_A)),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(sdk.dense.upsert).not.toHaveBeenCalled();
    expect(sdk.sparse.upsert).not.toHaveBeenCalled();
  });

  it('without a job scope nothing is gated or ended', async () => {
    const { backend, calls } = setup();
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(calls).toHaveLength(0);
  });

  it('an approval that arrives after the reader left is ended unreported and sends nothing', async () => {
    const sdk = fakeSdk();
    const backend = new PineconeBackend({
      client: sdk.client,
      config: { ...pineconeConfig({}, {}), pollIntervalMs: 1, timeoutMs: 20 },
      logUsage: () => undefined,
    });
    await backend.ensureReady();
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    sdk.dense.search.mockClear();
    let approve: (open: boolean) => void = () => undefined;
    const ends: CallEnd[] = [];
    const job: JobScope = {
      context: { readerId: 'a', jobKind: 'question', jobId: 'j', docId: DOC_A },
      spent: newSpend(),
      callGate: () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
      onCallEnd: (e) => {
        ends.push(e);
      },
    };
    const controller = new AbortController();
    const run = runInJob(job, () =>
      backend.search({
        docId: DOC_A,
        index: 'dense',
        query: 'town',
        topK: 2,
        signal: controller.signal,
      }),
    );
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(run).rejects.toThrow();
    approve(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sdk.dense.search).not.toHaveBeenCalled();
    expect(ends).toEqual([expect.objectContaining({ reported: false })]);
  });

  it('checks the kill switch again after the gate answers: nothing is sent', async () => {
    const { backend, sdk, job } = setup();
    await backend.ensureReady();
    await runInJob(job, () => backend.upsertChunks(DOC_A, CHUNKS_A));
    sdk.dense.search.mockClear();
    let closed = false;
    job.spendGate = () => !closed;
    job.callGate = () => {
      closed = true;
      return true;
    };
    await expect(
      runInJob(job, () =>
        backend.search({
          docId: DOC_A,
          index: 'dense',
          query: 'town',
          topK: 2,
        }),
      ),
    ).rejects.toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(sdk.dense.search).not.toHaveBeenCalled();
  });
});
