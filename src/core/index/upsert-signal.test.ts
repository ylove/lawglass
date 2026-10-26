import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fakePineconeClient } from '../../../tests/contracts/fake-pinecone-client.js';
import { FakeReranker } from '../../../tests/contracts/fake-local-models.js';
import { CHUNKS_A, DOC_A } from '../../../tests/contracts/sample-chunks.js';
import { pineconeConfig } from '../config.js';
import { LocalBackend, type Embedder } from './local/index.js';
import { PineconeBackend } from './pinecone/pinecone.js';

// Adapter behaviour for the additive `signal` of RetrievalBackend.upsertChunks (#221): cancelling an
// upsert stops embedding and upserting at once (the hosted server used to keep paying after a
// client disconnected) and never leaves a document that a later ask would read as complete.

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((r) => rm(r, { recursive: true, force: true })),
  );
});

/** Embeds two texts per batch and checks the signal between batches, like the real embedder. */
class BatchingEmbedder implements Embedder {
  readonly model = { id: 'batching', revision: '1' };
  readonly dims = 4;
  batches = 0;
  constructor(private readonly onBatch?: (batch: number) => void) {}
  ensureReady(): Promise<void> {
    return Promise.resolve();
  }
  embed(
    texts: readonly string[],
    _purpose: 'query' | 'document',
    signal?: AbortSignal,
  ) {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 2) {
      signal?.throwIfAborted();
      this.batches++;
      this.onBatch?.(this.batches);
      for (const _text of texts.slice(i, i + 2))
        vectors.push(Float32Array.of(1, 0, 0, 0));
    }
    return Promise.resolve({ vectors, tokens: texts.length });
  }
}

async function local(embedder: Embedder) {
  const root = await mkdtemp(join(tmpdir(), 'upsert-signal-'));
  roots.push(root);
  return {
    root,
    backend: new LocalBackend({ root, embedder, reranker: new FakeReranker() }),
  };
}

describe('local backend upsertChunks signal', () => {
  it('stops embedding further batches after an abort and leaves no document', async () => {
    const controller = new AbortController();
    const embedder = new BatchingEmbedder((n) => {
      if (n === 1) controller.abort();
    });
    const { root, backend } = await local(embedder);
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(CHUNKS_A.length).toBeGreaterThan(2);
    expect(embedder.batches).toBe(1);
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    // No staging directory or partial generation is left behind.
    expect(await readdir(root)).toEqual([]);
  });

  it('does not start embedding when the signal is already aborted', async () => {
    const embedder = new BatchingEmbedder();
    const { backend } = await local(embedder);
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(embedder.batches).toBe(0);
  });

  it('does not publish when aborted after embedding finished', async () => {
    const controller = new AbortController();
    const { backend } = await local(new BatchingEmbedder());
    await expect(
      backend.upsertChunks(
        DOC_A,
        CHUNKS_A,
        () => {
          controller.abort();
        },
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await backend.hasDocument(DOC_A)).toBe(false);
  });

  it('keeps the previous generation when an update is cancelled', async () => {
    const { backend } = await local(new BatchingEmbedder());
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    const edited = CHUNKS_A.map((c) => ({
      ...c,
      text: `${c.text} edited`,
      embedText: `${c.embedText} edited`,
    }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      backend.upsertChunks(DOC_A, edited, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const stored = await backend.getChunks(
      DOC_A,
      CHUNKS_A.map((c) => c.id),
    );
    expect(stored.map((c) => c.text).sort()).toEqual(
      CHUNKS_A.map((c) => c.text).sort(),
    );
  });
});

describe('pinecone backend upsertChunks signal', () => {
  function setup(upsertMaxBatchTokens: number) {
    const sdk = fakePineconeClient();
    const backend = new PineconeBackend({
      client: sdk.client,
      config: pineconeConfig({ upsertMaxBatchTokens }, {}),
      logUsage: () => undefined,
      sleep: () => Promise.resolve(),
    });
    return { sdk, backend };
  }

  it('stops sending batches after an abort and removes the half-written namespace', async () => {
    // A tiny token cap forces one record per batch, so there are several batches to cut short.
    const { sdk, backend } = setup(1);
    const controller = new AbortController();
    sdk.dense.upsert.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    // One dense batch went out; the sparse write and every later batch never started.
    expect(sdk.dense.upsert).toHaveBeenCalledTimes(1);
    expect(sdk.sparse.upsert).not.toHaveBeenCalled();
    expect(await backend.hasDocument(DOC_A)).toBe(false);
    expect(sdk.dense.deleteNamespace).toHaveBeenCalledWith(DOC_A);
  });

  it('publishes no completion marker when aborted before it', async () => {
    const { sdk, backend } = setup(1_000_000);
    const controller = new AbortController();
    sdk.sparse.upsert.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await backend.hasDocument(DOC_A)).toBe(false);
  });

  it('an update cancelled midway is never read as complete', async () => {
    const { sdk, backend } = setup(1);
    await backend.upsertChunks(DOC_A, CHUNKS_A);
    expect(await backend.hasDocument(DOC_A)).toBe(true);
    const controller = new AbortController();
    sdk.dense.upsert.mockImplementationOnce(() => {
      controller.abort();
      return Promise.resolve(undefined);
    });
    await expect(
      backend.upsertChunks(DOC_A, CHUNKS_A, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await backend.hasDocument(DOC_A)).toBe(false);
  });
});
