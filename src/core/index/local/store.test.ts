import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHUNKS_A, DOC_A } from '../../../../tests/contracts/sample-chunks.js';
import { buildBm25 } from './bm25.js';
import { FileStore, StoreMeta, type Snapshot } from './store.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    access: vi.fn(actual.access),
    writeFile: vi.fn(actual.writeFile),
  };
});

describe('atomic file store', () => {
  let root: string;
  let store: FileStore;
  const sample = (): Omit<Snapshot, 'meta'> & {
    meta: Omit<Snapshot['meta'], 'hashes'>;
  } => ({
    chunks: [CHUNKS_A[0]!],
    vectors: [new Float32Array(384)],
    bm25: buildBm25([CHUNKS_A[0]!.text]),
    meta: {
      version: 1,
      embedding: { id: 'fake', revision: '1' },
      reranker: { id: 'fake', revision: '1' },
      dims: 384,
      count: 1,
    },
  });
  beforeEach(async () => {
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.mocked(fs.rename).mockReset().mockImplementation(actual.rename);
    vi.mocked(fs.access).mockReset().mockImplementation(actual.access);
    vi.mocked(fs.writeFile).mockReset().mockImplementation(actual.writeFile);
    root = await fs.mkdtemp(join(tmpdir(), 'local-store-'));
    store = new FileStore(root);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const save = () => store.run(DOC_A, () => store.save(DOC_A, sample()));
  const load = () => store.run(DOC_A, () => store.load(DOC_A));

  it('does not publish meta on a staging write failure and cleans temporary files', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    await expect(save()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await load()).toBeUndefined();
    await save();
    expect(await load()).toBeDefined();
  });

  it('rolls back a failed replacement and preserves the previous generation', async () => {
    await save();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (
        String(source).endsWith('.tmp') &&
        String(destination) === join(root, DOC_A)
      )
        throw new Error('publish failed');
      return actual.rename(source, destination);
    });
    await expect(save()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect((await load())?.chunks).toEqual(sample().chunks);
    expect(await fs.readdir(root)).toEqual([DOC_A]);
  });

  it('allows a queued write to proceed when the preceding write fails', async () => {
    vi.spyOn(fs, 'writeFile').mockRejectedValueOnce(new Error('disk full'));
    const [first, second] = await Promise.allSettled([save(), save()]);
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('fulfilled');
    expect((await load())?.chunks).toEqual(sample().chunks);
  });

  it('recovers an interrupted replacement, discards obsolete backups, and deletes idempotently', async () => {
    await save();
    await fs.rename(join(root, DOC_A), join(root, `${DOC_A}.previous`));
    expect((await load())?.chunks).toEqual(sample().chunks);
    await fs.cp(join(root, DOC_A), join(root, `${DOC_A}.previous`), {
      recursive: true,
    });
    await load();
    expect(await fs.readdir(root)).toEqual([DOC_A]);
    await store.run(DOC_A, () => store.delete(DOC_A));
    await store.run(DOC_A, () => store.delete(DOC_A));
    expect(await load()).toBeUndefined();
  });

  it('reports permission failures instead of treating them as missing data', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'access').mockRejectedValueOnce(denied);
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    await save();
    vi.spyOn(fs, 'access')
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied);
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  });

  it('wraps rename failures during recovery and backup creation', async () => {
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(denied);
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    await save();
    const actual =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (String(destination).endsWith('.previous')) throw denied;
      return actual.rename(source, destination);
    });
    await expect(save()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    expect((await load())?.chunks).toEqual(sample().chunks);
  });

  it('only regards a namespace with a completion marker as present', async () => {
    await fs.mkdir(join(root, DOC_A));
    await fs.writeFile(join(root, DOC_A, 'chunks.jsonl'), '{}');
    expect(await store.run(DOC_A, () => store.has(DOC_A))).toBe(false);
  });

  it('validates JSON and schemas read from disk', async () => {
    await save();
    await fs.writeFile(join(root, DOC_A, 'meta.json'), '{');
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    await save();
    await fs.writeFile(join(root, DOC_A, 'meta.json'), '{"version":2}');
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  });

  it('checks hashes for each index file', async () => {
    for (const file of ['chunks.jsonl', 'dense.f32', 'bm25.json']) {
      await save();
      await fs.writeFile(join(root, DOC_A, file), 'corrupt');
      await expect(load()).rejects.toMatchObject({
        code: 'BACKEND_UNAVAILABLE',
      });
    }
  });

  it('rejects incorrect counts, namespaces, duplicate ids and non-finite dense data', async () => {
    await save();
    const original = StoreMeta.parse(
      JSON.parse(await fs.readFile(join(root, DOC_A, 'meta.json'), 'utf8')),
    );
    for (const meta of [
      { ...original, count: 2 },
      { ...original, dims: 1 },
    ]) {
      await fs.writeFile(join(root, DOC_A, 'meta.json'), JSON.stringify(meta));
      await expect(load()).rejects.toMatchObject({
        code: 'BACKEND_UNAVAILABLE',
      });
    }
    const wrong = sample();
    wrong.chunks[0] = { ...CHUNKS_A[0]!, docId: 'other' };
    await store.run(DOC_A, () => store.save(DOC_A, wrong));
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    const duplicate = sample();
    duplicate.chunks.push(CHUNKS_A[0]!);
    duplicate.vectors.push(new Float32Array(384));
    duplicate.bm25 = buildBm25(duplicate.chunks.map((c) => c.text));
    duplicate.meta.count = 2;
    await store.run(DOC_A, () => store.save(DOC_A, duplicate));
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
    const nan = sample();
    nan.vectors[0]![0] = NaN;
    await store.run(DOC_A, () => store.save(DOC_A, nan));
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  });

  it('validates sparse row lengths even when file checksums match', async () => {
    await save();
    const sparseBytes = JSON.stringify({
      lengths: [],
      averageLength: 0,
      documentFrequency: {},
      termFrequency: [],
    });
    const meta = StoreMeta.parse(
      JSON.parse(await fs.readFile(join(root, DOC_A, 'meta.json'), 'utf8')),
    );
    meta.hashes.bm25 = createHash('sha256').update(sparseBytes).digest('hex');
    await fs.writeFile(join(root, DOC_A, 'bm25.json'), sparseBytes);
    await fs.writeFile(join(root, DOC_A, 'meta.json'), JSON.stringify(meta));
    await expect(load()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  });
});
