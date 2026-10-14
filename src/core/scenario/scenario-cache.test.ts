import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
  chmod,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerCache } from '../answer-cache.js';
import { configFileSystem } from '../config-files.js';
import { exampleScenario } from '../../../tests/synth/scenario.js';
import {
  NONE_RETRY_MS,
  ScenarioCache,
  scenarioCacheHash,
  type ScenarioCacheKey,
} from './scenario-cache.js';

const DOC = 'a'.repeat(64);
const key: ScenarioCacheKey = {
  docId: DOC,
  subject: 'A  Renter',
  provider: 'mock',
  model: 'mock-1',
  promptVersion: 'v1',
};
let dir: string;
let clock: number;
let registered: boolean;
const make = (): ScenarioCache =>
  new ScenarioCache({
    dir,
    now: () => clock,
    isStillRegistered: () => registered,
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scenario-cache-'));
  clock = 1_000_000;
  registered = true;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('scenarioCacheHash', () => {
  it('ignores case and spacing of the subject but nothing else', () => {
    expect(scenarioCacheHash({ ...key, subject: 'a renter' })).toBe(
      scenarioCacheHash(key),
    );
    for (const change of [
      { subject: 'a landlord' },
      { provider: 'other' },
      { model: 'mock-2' },
      { promptVersion: 'v2' },
    ])
      expect(scenarioCacheHash({ ...key, ...change })).not.toBe(
        scenarioCacheHash(key),
      );
  });
});

describe('ScenarioCache', () => {
  it('misses, computes once, then hits without computing', async () => {
    const cache = make();
    expect(await cache.get(key)).toBeUndefined();
    const compute = vi.fn(() =>
      Promise.resolve({ status: 'ok' as const, scenario: exampleScenario() }),
    );
    const first = await cache.getOrCompute(key, compute);
    const second = await make().getOrCompute(
      { ...key, subject: 'a renter' },
      compute,
    );
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    const files = await readdir(join(dir, DOC));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^scenario-[0-9a-f]{64}\.json$/);
  });

  it('a different provider, model or prompt version is a miss', async () => {
    const cache = make();
    await cache.getOrCompute(key, () =>
      Promise.resolve({ status: 'ok' as const, scenario: exampleScenario() }),
    );
    for (const change of [
      { model: 'x' },
      { provider: 'x' },
      { promptVersion: 'x' },
    ])
      expect(await cache.get({ ...key, ...change })).toBeUndefined();
  });

  it('serves a none result during the cool-down, then retries', async () => {
    const cache = make();
    const compute = vi.fn(() => Promise.resolve({ status: 'none' as const }));
    await cache.getOrCompute(key, compute);
    clock += NONE_RETRY_MS - 1;
    expect(await cache.getOrCompute(key, compute)).toEqual({ status: 'none' });
    expect(compute).toHaveBeenCalledTimes(1);
    clock += 1;
    expect(await cache.get(key)).toBeUndefined();
    await cache.getOrCompute(key, compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('shares one computation between concurrent callers', async () => {
    const cache = make();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const compute = vi.fn(async () => {
      await gate;
      return { status: 'none' as const };
    });
    const both = Promise.all([
      cache.getOrCompute(key, compute),
      make().getOrCompute(key, compute),
    ]);
    release();
    await both;
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('does not write for a document that was removed meanwhile, and still returns the result', async () => {
    const cache = make();
    registered = false;
    const result = await cache.getOrCompute(key, () =>
      Promise.resolve({ status: 'none' as const }),
    );
    expect(result).toEqual({ status: 'none' });
    await expect(readdir(join(dir, DOC))).rejects.toThrow();
  });

  it('a write that finishes after the document was evicted is dropped, even though it is still registered', async () => {
    const cache = make();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = cache.getOrCompute(key, async () => {
      await gate;
      return { status: 'none' as const };
    });
    // Removal deletes the directory while the registry still lists the document.
    await new AnswerCache({ dir }).evictDocument(DOC);
    release();
    expect(await pending).toEqual({ status: 'none' });
    await expect(readdir(join(dir, DOC))).rejects.toThrow();
    // A later request, started after the eviction, may cache again.
    await make().getOrCompute(key, () =>
      Promise.resolve({ status: 'none' as const }),
    );
    expect(await readdir(join(dir, DOC))).toHaveLength(1);
  });

  it('a write already queued when eviction starts waits for it and is then dropped', async () => {
    const cache = make();
    let finish: () => void = () => undefined;
    const slowRm = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = Promise.resolve({ status: 'none' as const });
    const writing = cache.getOrCompute(key, () => result);
    // Evict while the lookup/compute is still in progress, with a slow directory removal.
    const evicting = new AnswerCache({
      dir,
      fs: {
        ...configFileSystem,
        rm: async (...args) => {
          await slowRm;
          return rm(...args);
        },
      },
    }).evictDocument(DOC);
    finish();
    await Promise.all([evicting, writing]);
    await expect(readdir(join(dir, DOC))).rejects.toThrow();
  });

  it('treats corrupt, invalid and unsafe files as misses', async () => {
    const cache = make();
    await cache.getOrCompute(key, () =>
      Promise.resolve({ status: 'ok' as const, scenario: exampleScenario() }),
    );
    const [name] = await readdir(join(dir, DOC));
    const path = join(dir, DOC, name!);
    await writeFile(path, '{not json', { mode: 0o600 });
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(
      path,
      JSON.stringify({
        status: 'ok',
        provider: 'mock',
        model: 'mock-1',
        storedAt: 1,
      }),
      { mode: 0o600 },
    );
    expect(await cache.get(key)).toBeUndefined();
    await writeFile(path, JSON.stringify({ nope: true }), { mode: 0o600 });
    expect(await cache.get(key)).toBeUndefined();
    await chmod(path, 0o644);
    expect(await cache.get(key)).toBeUndefined();
    expect((await readFile(path, 'utf8')).length).toBeGreaterThan(0);
  });

  it('rejects a document id that could escape the directory', async () => {
    const cache = make();
    const bad = { ...key, docId: '../x' };
    expect(await cache.get(bad)).toBeUndefined();
    expect(() =>
      cache.getOrCompute(bad, () => Promise.reject(new Error('no'))),
    ).toThrow();
  });
});
