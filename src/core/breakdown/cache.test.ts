import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BreakdownCache,
  breakdownCacheHash,
  type BreakdownCacheKey,
  type StoredBreakdown,
} from './cache.js';

const DOC = 'a'.repeat(64);
const KEY: BreakdownCacheKey = {
  docId: DOC,
  provider: 'anthropic',
  model: 'm1',
  endpoint: 'anthropic:default',
  promptVersion: 'v1',
  context: 'whole',
};
const STORED: StoredBreakdown = {
  briefs: [
    {
      sectionId: 'sec-2',
      text: 'Towns get grants. [S:sec-2]',
      citations: [{ sectionId: 'sec-2', valid: true, chunkIds: [] }],
      readingGrade: 3,
      example: 'available',
    },
  ],
  omitted: 0,
  context: 'whole',
  provider: 'anthropic',
  model: 'm1',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'breakdown-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('breakdownCacheHash', () => {
  it('changes with every part of the identity', () => {
    const base = breakdownCacheHash(KEY);
    for (const change of [
      { provider: 'openai' },
      { model: 'm2' },
      { endpoint: 'other' },
      { promptVersion: 'v2' },
      { context: 'excerpts' as const },
    ])
      expect(breakdownCacheHash({ ...KEY, ...change })).not.toBe(base);
  });
});

describe('BreakdownCache', () => {
  it('misses, computes once for concurrent callers, then hits', async () => {
    const cache = new BreakdownCache({ dir });
    expect(await cache.get(KEY)).toBeUndefined();
    const compute = vi.fn(() => Promise.resolve(STORED));
    const [a, b] = await Promise.all([
      cache.getOrCompute(KEY, compute),
      cache.getOrCompute(KEY, compute),
    ]);
    expect(a).toEqual(STORED);
    expect(b).toEqual(STORED);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await new BreakdownCache({ dir }).get(KEY)).toEqual(STORED);
  });

  it('does not store an empty or missing result', async () => {
    const cache = new BreakdownCache({ dir });
    expect(
      await cache.getOrCompute(KEY, () => Promise.resolve(undefined)),
    ).toBeUndefined();
    expect(
      await cache.getOrCompute(KEY, () =>
        Promise.resolve({ ...STORED, briefs: [] }),
      ),
    ).toMatchObject({ briefs: [] });
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('treats a corrupt file and another model as a miss', async () => {
    const cache = new BreakdownCache({ dir });
    await cache.getOrCompute(KEY, () => Promise.resolve(STORED));
    const [file] = await readdir(join(dir, DOC));
    await writeFile(join(dir, DOC, file!), '{nope', { mode: 0o600 });
    expect(await cache.get(KEY)).toBeUndefined();
    await cache.getOrCompute({ ...KEY, promptVersion: 'v9' }, () =>
      Promise.resolve({ ...STORED, model: 'other' }),
    );
    expect(await cache.get({ ...KEY, promptVersion: 'v9' })).toBeUndefined();
  });

  it('does not write for a document that is no longer registered', async () => {
    const cache = new BreakdownCache({ dir, isStillRegistered: () => false });
    await cache.getOrCompute(KEY, () => Promise.resolve(STORED));
    expect(await cache.get(KEY)).toBeUndefined();
  });

  it('refuses a hostile document id', async () => {
    const cache = new BreakdownCache({ dir });
    await expect(
      cache.get({ ...KEY, docId: '../escape' }),
    ).resolves.toBeUndefined();
    expect(() =>
      cache.getOrCompute({ ...KEY, docId: '../escape' }, () =>
        Promise.resolve(STORED),
      ),
    ).toThrow();
  });
});
