import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';
import { CHUNKS_A, DOC_A, DOC_B } from '../../tests/contracts/sample-chunks.js';
import { ScriptedProvider } from '../../tests/contracts/scripted-provider.js';
import { answer } from './answer/index.js';
import {
  AnswerCache,
  answerCacheKey,
  type AnswerCacheKey,
} from './answer-cache.js';
import { SUMMARY_PROMPT_VERSION } from './chip-summary.js';
import { DECLINE_TEXT, type AnswerResult } from './model/index.js';

let scratch: string;
let dir: string;
let cache: AnswerCache;
let result: AnswerResult;
const key: AnswerCacheKey = {
  docId: DOC_A,
  chipId: 'summary',
  provider: 'mock',
  model: 'scripted',
  promptVersion: SUMMARY_PROMPT_VERSION,
};
const pathFor = (k: AnswerCacheKey = key): string =>
  join(dir, k.docId, `${answerCacheKey(k)}.json`);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  scratch = await fs.mkdtemp(join(tmpdir(), 'answer-cache-test-'));
  dir = join(scratch, 'cache', 'answers');
  cache = new AnswerCache({ dir });
  const backend = new MemoryBackend();
  await backend.upsertChunks(DOC_A, CHUNKS_A);
  const { hits } = await backend.search({
    docId: DOC_A,
    index: 'dense',
    query: 'water grants',
    topK: 8,
  });
  result = await answer({
    provider: new ScriptedProvider({
      reply: 'The bill funds water grants [S:sec-3].',
    }),
    question: 'Summarize this bill',
    context: { hits },
  });
});
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true });
});

describe('AnswerCache', () => {
  it('uses the specified hash and invalidates every key component', async () => {
    expect(answerCacheKey(key)).toBe(
      createHash('sha256')
        .update(`${DOC_A}|summary|mock|scripted|${SUMMARY_PROMPT_VERSION}`)
        .digest('hex'),
    );
    await cache.set(key, result);
    const variants: AnswerCacheKey[] = [
      { ...key, docId: DOC_B },
      { ...key, chipId: 'money' },
      { ...key, provider: 'openai' },
      { ...key, model: 'other' },
      { ...key, promptVersion: '2' },
    ];
    expect(new Set([key, ...variants].map(answerCacheKey)).size).toBe(6);
    for (const variant of variants)
      expect(await cache.get(variant)).toBeUndefined();
  });

  it('misses without creating files, computes once, and hits after reopening', async () => {
    expect(await cache.get(key)).toBeUndefined();
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    const compute = vi.fn(() => Promise.resolve(result));
    expect(await cache.getOrCompute(key, compute)).toEqual(result);
    expect(await new AnswerCache({ dir }).getOrCompute(key, compute)).toEqual(
      result,
    );
    expect(compute).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await fs.readFile(pathFor(), 'utf8'))).toEqual(result);
  });

  it('shares one in-flight promise across callers and instances', async () => {
    const ready = deferred<undefined>();
    const pending = deferred<AnswerResult>();
    const compute = vi.fn(() => {
      ready.resolve(undefined);
      return pending.promise;
    });
    const first = cache.getOrCompute(key, compute);
    const second = new AnswerCache({ dir }).getOrCompute({ ...key }, compute);
    expect(first).toBe(second);
    await ready.promise;
    pending.resolve(result);
    expect(await Promise.all([first, second])).toEqual([result, result]);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not deduplicate different keys or different directories', async () => {
    const compute = vi.fn(() => Promise.resolve(result));
    await Promise.all([
      cache.getOrCompute(key, compute),
      cache.getOrCompute({ ...key, chipId: 'money' }, compute),
      new AnswerCache({ dir: join(scratch, 'other') }).getOrCompute(
        key,
        compute,
      ),
    ]);
    expect(compute).toHaveBeenCalledTimes(3);
  });

  it('shares a compute rejection, stores nothing, and retries (including synchronous throws)', async () => {
    const failure = new Error('provider failed');
    const compute = vi.fn((): Promise<AnswerResult> => {
      throw failure;
    });
    const first = cache.getOrCompute(key, compute);
    const second = cache.getOrCompute(key, compute);
    await expect(first).rejects.toBe(failure);
    await expect(second).rejects.toBe(failure);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await cache.get(key)).toBeUndefined();
    expect(
      await cache.getOrCompute(key, () => Promise.resolve(result)),
    ).toEqual(result);
  });

  it.each([
    { declined: true, text: DECLINE_TEXT },
    { warnings: ['NO_VALID_CITATIONS'] as AnswerResult['warnings'] },
  ])('never caches a decline or citation failure: %j', async (overrides) => {
    const invalid = { ...result, ...overrides };
    const compute = vi.fn(() => Promise.resolve(invalid));
    expect(await cache.getOrCompute(key, compute)).toEqual(invalid);
    await cache.getOrCompute(key, compute);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(await cache.get(key)).toBeUndefined();
    // An old or tampered file must obey the same policy on read.
    await fs.mkdir(join(dir, DOC_A), { recursive: true, mode: 0o700 });
    await fs.writeFile(pathFor(), JSON.stringify(invalid), { mode: 0o600 });
    expect(await cache.get(key)).toBeUndefined();
  });

  it('writes 0600 files and 0700 directories, repairing an existing file mode', async () => {
    await cache.set(key, result);
    await fs.chmod(pathFor(), 0o644);
    await fs.chmod(dir, 0o755);
    expect(await cache.get(key)).toBeUndefined();
    await cache.set(key, result);
    expect((await fs.stat(pathFor())).mode & 0o777).toBe(0o600);
    for (const path of [join(scratch, 'cache'), dir, join(dir, DOC_A)])
      expect((await fs.stat(path)).mode & 0o777).toBe(0o700);
    expect(await fs.readdir(join(dir, DOC_A))).toEqual([
      `${answerCacheKey(key)}.json`,
    ]);
  });

  it('refuses a write when the directory cannot be made private', async () => {
    const failing = new AnswerCache({
      dir,
      fs: {
        ...fs,
        chmod: vi.fn().mockRejectedValue(new Error('sensitive path')),
      },
    });
    await expect(failing.set(key, result)).rejects.toThrow(
      'The answer cache directory could not be secured.',
    );
    expect(await cache.get(key)).toBeUndefined();
  });

  it.each(['{bad json', '{}'])(
    'treats corrupt JSON/schema as a miss and replaces it: %s',
    async (text) => {
      await cache.set(key, result);
      await fs.writeFile(pathFor(), text);
      expect(await cache.get(key)).toBeUndefined();
      await cache.getOrCompute(key, () => Promise.resolve(result));
      expect(await cache.get(key)).toEqual(result);
    },
  );

  it('rejects schema-invalid and mismatched results and ignores mismatches on disk', async () => {
    for (const invalid of [
      { ...result, text: 42 },
      { ...result, model: 'wrong' },
    ]) {
      expect(() => cache.set(key, invalid as AnswerResult)).toThrow(
        'Invalid answer cache result',
      );
    }
    await cache.set(key, result);
    for (const invalid of [
      { ...result, model: 'wrong' },
      { ...result, provider: 'wrong' },
    ]) {
      await fs.writeFile(pathFor(), JSON.stringify(invalid));
      expect(await cache.get(key)).toBeUndefined();
    }
  });

  it('validates paths and refuses ambiguous delimited keys', () => {
    for (const invalid of [
      { ...key, docId: '../escape' },
      { ...key, chipId: 'unknown' },
      { ...key, provider: '' },
      { ...key, model: 'model|version' },
      { ...key, promptVersion: '' },
    ])
      expect(() => cache.get(invalid as AnswerCacheKey)).toThrow(
        'Invalid answer cache key',
      );
    expect(() => cache.evictDocument('../escape')).toThrow(
      'Invalid answer cache document id',
    );
  });

  it('evicts all chips and prompt versions only for that document, idempotently', async () => {
    const other = { ...key, docId: DOC_B };
    await Promise.all([
      cache.set(key, result),
      cache.set({ ...key, chipId: 'money', promptVersion: 'old' }, result),
      cache.set(other, result),
    ]);
    await cache.evictDocument(DOC_A);
    await cache.evictDocument(DOC_A);
    expect(await cache.get(key)).toBeUndefined();
    expect(
      await cache.get({ ...key, chipId: 'money', promptVersion: 'old' }),
    ).toBeUndefined();
    expect(await cache.get(other)).toEqual(result);
    await expect(fs.stat(join(dir, DOC_A))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('prevents an in-flight compute from resurrecting an evicted document', async () => {
    const pending = deferred<AnswerResult>();
    const ready = deferred<undefined>();
    const first = cache.getOrCompute(key, () => {
      ready.resolve(undefined);
      return pending.promise;
    });
    await ready.promise;
    await new AnswerCache({ dir }).evictDocument(DOC_A);
    // A new generation is independent of the old one after re-ingest.
    const newer = { ...result, text: 'New result [S:sec-3].' };
    expect(await cache.getOrCompute(key, () => Promise.resolve(newer))).toEqual(
      newer,
    );
    pending.resolve(result);
    expect(await first).toEqual(result);
    expect(await cache.get(key)).toEqual(newer);
  });

  it('serializes an already queued write before eviction', async () => {
    const write = cache.set(key, result);
    const evict = cache.evictDocument(DOC_A);
    await Promise.all([write, evict]);
    expect(await cache.get(key)).toBeUndefined();
  });

  it('sanitizes write and eviction errors and allows a retry after failed storage', async () => {
    const failing = new AnswerCache({
      dir,
      fs: {
        ...fs,
        rename: vi.fn().mockRejectedValue(new Error('sensitive file contents')),
        rm: vi.fn().mockRejectedValue(new Error('sensitive path')),
      },
    });
    await expect(
      failing.getOrCompute(key, () => Promise.resolve(result)),
    ).rejects.toThrow('The local data file could not be saved.');
    await expect(failing.evictDocument(DOC_A)).rejects.toThrow(
      'The cached answers could not be removed.',
    );
    expect(await fs.readdir(join(dir, DOC_A))).toEqual([]);
    expect(
      await cache.getOrCompute(key, () => Promise.resolve(result)),
    ).toEqual(result);
  });
});
