import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PictureEntry } from '../model/index.js';
import {
  PictureCache,
  pictureCacheHash,
  pictureSourceHash,
  type PictureCacheKey,
} from './cache.js';

const DOC = 'a'.repeat(64);
const entry: PictureEntry = {
  item: 0,
  text: 'Banks report monthly [S:sec-1].',
  panels: [{ left: { glyphs: ['bank'] }, link: 'none' }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'picture-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const key = (over: Partial<PictureCacheKey> = {}): PictureCacheKey => ({
  docId: DOC,
  source: 'summary',
  sourceHash: pictureSourceHash([{ text: entry.text }]),
  provider: 'anthropic',
  model: 'claude-haiku-5-5',
  promptVersion: 'v1',
  ...over,
});

describe('PictureCache', () => {
  it('stores once and serves the stored entries, including an empty result', async () => {
    const cache = new PictureCache({ dir });
    const compute = vi.fn(() => Promise.resolve([entry]));
    expect(await cache.getOrCompute(key(), compute)).toEqual([entry]);
    expect(await cache.getOrCompute(key(), compute)).toEqual([entry]);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(await cache.get(key())).toEqual([entry]);
    await cache.getOrCompute(key({ source: 'breakdown' }), () =>
      Promise.resolve([]),
    );
    expect(await cache.get(key({ source: 'breakdown' }))).toEqual([]);
    expect(
      (await readdir(join(dir, DOC))).every((f) => f.startsWith('pictures-')),
    ).toBe(true);
  });

  it('shares one run between concurrent callers', async () => {
    const cache = new PictureCache({ dir });
    let calls = 0;
    const compute = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 10));
      return [entry];
    };
    await Promise.all([
      cache.getOrCompute(key(), compute),
      cache.getOrCompute(key(), compute),
    ]);
    expect(calls).toBe(1);
  });

  it('new source text, another model or a new prompt is a miss', async () => {
    const cache = new PictureCache({ dir });
    await cache.getOrCompute(key(), () => Promise.resolve([entry]));
    expect(
      await cache.get(
        key({ sourceHash: pictureSourceHash([{ text: 'Changed text.' }]) }),
      ),
    ).toBeUndefined();
    expect(await cache.get(key({ model: 'other' }))).toBeUndefined();
    expect(await cache.get(key({ promptVersion: 'v2' }))).toBeUndefined();
  });

  it('does not write for a document removed while drawing, and refuses hostile ids', async () => {
    const cache = new PictureCache({ dir, isStillRegistered: () => false });
    expect(
      await cache.getOrCompute(key(), () => Promise.resolve([entry])),
    ).toEqual([entry]);
    expect(await cache.get(key())).toBeUndefined();
    expect(() => pictureCacheHash(key({ docId: '../x' }))).not.toThrow();
    await expect(
      cache.get(key({ docId: '../escape' })),
    ).resolves.toBeUndefined();
    expect(() =>
      cache.getOrCompute(key({ docId: '../escape' }), () =>
        Promise.resolve([]),
      ),
    ).toThrow(/Invalid picture cache document id/);
  });

  it('hashes the source by parts and texts, in order', () => {
    expect(pictureSourceHash([{ text: 'a' }, { text: 'b' }])).not.toBe(
      pictureSourceHash([{ text: 'b' }, { text: 'a' }]),
    );
    expect(pictureSourceHash([{ text: 'a', sectionId: 's1' }])).not.toBe(
      pictureSourceHash([{ text: 'a', sectionId: 's2' }]),
    );
  });
});
