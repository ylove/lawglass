import * as realFs from 'node:fs/promises';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BRAND, envVar } from '../brand.js';
import {
  cacheBudgetBytes,
  clearCache,
  DEFAULT_CACHE_BUDGET_BYTES,
  defaultCacheDir,
  documentId,
  type CacheFs,
  evictToBudget,
  readCache,
  removeCached,
  writeCache,
} from './cache.js';

let dir: string;
const metadata = {
  url: 'https://example.gov/bill',
  finalUrl: 'https://example.gov/bill.xml',
  contentType: 'application/xml',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};
const bytes = new TextEncoder().encode('<bill/>');
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'safe-cache-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('uses the branded home directory and accepts a config root', () => {
  expect(defaultCacheDir()).toBe(join(homedir(), BRAND.configDirName, 'cache'));
  expect(defaultCacheDir(dir)).toBe(join(dir, 'cache'));
});
it('writes raw bytes and a validated sidecar, with a stable content hash', async () => {
  const cacheDir = join(dir, 'cache');
  const docId = await writeCache(bytes, metadata, cacheDir);
  expect(docId).toMatch(/^[a-f0-9]{64}$/);
  expect(await readFile(join(cacheDir, docId))).toEqual(Buffer.from(bytes));
  expect(
    JSON.parse(
      await readFile(join(cacheDir, `${docId}.json`), 'utf8'),
    ) as unknown,
  ).toEqual(metadata);
  expect((await stat(join(cacheDir, docId))).mode & 0o777).toBe(0o600);
  expect(await readCache(metadata.url, cacheDir)).toEqual({
    ...metadata,
    docId,
    bytes: Buffer.from(bytes),
  });
  expect(await writeCache(bytes, metadata, cacheDir)).toBe(documentId(bytes));
});
it('treats absent, unrelated, invalid and corrupted entries as misses', async () => {
  expect(await readCache(metadata.url, join(dir, 'missing'))).toBeUndefined();
  const docId = await writeCache(bytes, metadata, dir);
  expect(await readCache('https://example.gov/other', dir)).toBeUndefined();
  await writeFile(join(dir, 'unrelated.json'), '{}');
  await writeFile(join(dir, `${docId}.json`), 'not JSON');
  expect(await readCache(metadata.url, dir)).toBeUndefined();
  await writeFile(join(dir, `${docId}.json`), '{}');
  expect(await readCache(metadata.url, dir)).toBeUndefined();
  await writeCache(bytes, metadata, dir);
  await writeFile(join(dir, docId), 'tampered');
  expect(await readCache(metadata.url, dir)).toBeUndefined();
  await rm(join(dir, docId));
  expect(await readCache(metadata.url, dir)).toBeUndefined();
});
it('enforces cache size limits and propagates filesystem failures', async () => {
  await writeCache(bytes, metadata, dir);
  await expect(readCache(metadata.url, dir, 1)).rejects.toMatchObject({
    code: 'TOO_LARGE',
  });
  const file = join(dir, 'file');
  await writeFile(file, 'x');
  await expect(readCache(metadata.url, file)).rejects.toMatchObject({
    code: 'ENOTDIR',
  });
  await expect(writeCache(bytes, metadata, file)).rejects.toThrow();
});
it('reads a docId directly without needing the URL index or unrelated sidecars', async () => {
  const docId = await writeCache(bytes, metadata, dir);
  await rm(join(dir, 'index.json'));
  await writeFile(join(dir, 'unrelated.json'), 'invalid');
  expect(await readCache(docId, dir)).toMatchObject({
    ...metadata,
    docId,
    bytes: Buffer.from(bytes),
  });
  expect(await readCache(metadata.url, dir)).toBeUndefined();
  expect(await readCache('a'.repeat(64), dir)).toBeUndefined();
});
it('atomically indexes URLs and replaces a URL mapping with its newest content hash', async () => {
  const first = await writeCache(bytes, metadata, dir);
  const updatedBytes = new TextEncoder().encode('<bill>updated</bill>');
  const second = await writeCache(updatedBytes, metadata, dir);
  expect(
    JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as unknown,
  ).toEqual({ [metadata.url]: second });
  expect(await readCache(metadata.url, dir)).toMatchObject({ docId: second });
  expect(await readCache(first, dir)).toMatchObject({ docId: first });
  expect((await readdir(dir)).filter((file) => file.endsWith('.tmp'))).toEqual(
    [],
  );
});
it('retains all URL mappings when downloads write concurrently', async () => {
  const urls = Array.from(
    { length: 8 },
    (_, index) => `https://example.gov/bill/${String(index)}`,
  );
  const ids = await Promise.all(
    urls.map((url) =>
      writeCache(new TextEncoder().encode(url), { ...metadata, url }, dir),
    ),
  );
  expect(
    JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')) as unknown,
  ).toEqual(Object.fromEntries(urls.map((url, index) => [url, ids[index]])));
  for (const [index, url] of urls.entries())
    expect(await readCache(url, dir)).toMatchObject({ docId: ids[index] });
});
it('treats corrupt or unsafe indexes as misses and repairs them on write', async () => {
  const docId = await writeCache(bytes, metadata, dir);
  for (const index of [
    'not JSON',
    JSON.stringify({ [metadata.url]: '../outside' }),
    JSON.stringify({ 'invalid URL': docId }),
  ]) {
    await writeFile(join(dir, 'index.json'), index);
    expect(await readCache(metadata.url, dir)).toBeUndefined();
    expect(await readCache(docId, dir)).toMatchObject({ docId });
    await writeCache(bytes, metadata, dir);
    expect(await readCache(metadata.url, dir)).toMatchObject({ docId });
  }
});

// G13: cached bytes are removed with the document, and only the bytes nothing else needs.
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const meta = (url: string, finalUrl = url) => ({
  url,
  finalUrl,
  contentType: 'text/plain',
  fetchedAt: '2026-10-13T00:00:00.000Z',
});
const indexOf = async (cacheDir: string): Promise<Record<string, string>> =>
  JSON.parse(await readFile(join(cacheDir, 'index.json'), 'utf8')) as Record<
    string,
    string
  >;

it('removes a snapshot, its sidecar and every URL that pointed at it', async () => {
  const one = await writeCache(bytesOf('one'), meta('https://a.gov/1'), dir);
  // Two URLs for identical bytes share one snapshot (for example an alias or a mirror).
  await writeCache(bytesOf('one'), meta('https://b.gov/1'), dir);
  const two = await writeCache(bytesOf('two'), meta('https://a.gov/2'), dir);
  await removeCached([one], dir);
  const files = await readdir(dir);
  expect(files).not.toContain(one);
  expect(files).not.toContain(`${one}.json`);
  expect(files).toContain(two);
  expect(await indexOf(dir)).toEqual({ 'https://a.gov/2': two });
  expect(await readCache('https://a.gov/1', dir)).toBeUndefined();
  expect((await readCache('https://a.gov/2', dir))?.docId).toBe(two);
});

it('leaves a URL alone when it has since been fetched again and points at a newer snapshot', async () => {
  // The same URL ingested twice as the page changed: two documents, one shared URL.
  const url = 'https://a.gov/bill';
  const older = await writeCache(bytesOf('v1'), meta(url), dir);
  const newer = await writeCache(bytesOf('v2'), meta(url), dir);
  expect(await indexOf(dir)).toEqual({ [url]: newer });
  await removeCached([older], dir);
  expect(await readdir(dir)).not.toContain(older);
  expect(await indexOf(dir)).toEqual({ [url]: newer });
  expect((await readCache(url, dir))?.docId).toBe(newer);
  await removeCached([newer], dir);
  expect(await indexOf(dir)).toEqual({});
  expect(await readdir(dir)).toEqual(['index.json']);
});

it('ignores ids that are not content hashes, so a path can never escape the cache', async () => {
  const outside = join(dir, '..', 'victim');
  await writeFile(outside, 'keep');
  const docId = await writeCache(bytesOf('x'), meta('https://a.gov/x'), dir);
  await removeCached(['../victim', 'index', `${docId}.json`, ''], dir);
  expect(await readFile(outside, 'utf8')).toBe('keep');
  expect(await readdir(dir)).toContain(docId);
  await rm(outside);
});

it('tolerates removal from a missing directory or of an unknown snapshot', async () => {
  await removeCached(['a'.repeat(64)], join(dir, 'missing'));
  await removeCached([], dir);
  expect(await readdir(dir)).toEqual([]);
  await writeCache(bytesOf('x'), meta('https://a.gov/x'), dir);
  await removeCached(['b'.repeat(64)], dir);
  expect(Object.keys(await indexOf(dir))).toEqual(['https://a.gov/x']);
});

it('evicts least recently used snapshots first and drops their URLs', async () => {
  const ids: string[] = [];
  for (const [i, name] of ['a', 'b', 'c'].entries()) {
    ids.push(
      await writeCache(
        bytesOf(name.repeat(100)),
        meta(`https://x.gov/${name}`),
        dir,
      ),
    );
    const when = new Date(Date.UTC(2026, 0, 1 + i));
    await utimes(join(dir, ids[i] ?? ''), when, when);
  }
  const [a = '', b = '', c = ''] = ids;
  // A cache hit refreshes recency: reading "a" makes "b" the oldest.
  await readCache('https://x.gov/a', dir);
  const size = async (id: string) =>
    (await stat(join(dir, id))).size +
    (await stat(join(dir, `${id}.json`))).size;
  const budget = (await size(a)) + (await size(c)) + 1;
  expect(await evictToBudget(dir, budget)).toEqual([b]);
  const files = await readdir(dir);
  expect(files).toContain(a);
  expect(files).toContain(c);
  expect(files).not.toContain(b);
  expect(Object.keys(await indexOf(dir)).sort()).toEqual([
    'https://x.gov/a',
    'https://x.gov/c',
  ]);
});

it('does nothing within the budget, and never evicts the snapshot to keep', async () => {
  const a = await writeCache(
    bytesOf('a'.repeat(50)),
    meta('https://x.gov/a'),
    dir,
  );
  expect(await evictToBudget(dir, 1_000_000)).toEqual([]);
  expect(await evictToBudget(dir, 1, a)).toEqual([]);
  expect(await readdir(dir)).toContain(a);
  expect(await evictToBudget(join(dir, 'missing'), 1)).toEqual([]);
});

it('ignores stray files when measuring the cache', async () => {
  const a = await writeCache(bytesOf('a'), meta('https://x.gov/a'), dir);
  await writeFile(join(dir, 'notes.txt'), 'z'.repeat(10_000));
  await mkdir(join(dir, 'answers'));
  await writeFile(join(dir, 'answers', 'q.json'), 'z'.repeat(10_000));
  expect(await evictToBudget(dir, 10_000)).toEqual([]);
  expect(await readdir(dir)).toContain(a);
});

it('clears snapshots, sidecars and the index but nothing else', async () => {
  await writeCache(bytesOf('a'), meta('https://x.gov/a'), dir);
  await writeCache(bytesOf('b'), meta('https://x.gov/b'), dir);
  await mkdir(join(dir, 'answers'));
  await writeFile(join(dir, 'answers', 'keep.json'), '{}');
  const result = await clearCache(dir);
  expect(result.snapshots).toBe(2);
  expect(result.bytes).toBeGreaterThan(0);
  expect((await readdir(dir)).sort()).toEqual(['answers']);
  expect(await readFile(join(dir, 'answers', 'keep.json'), 'utf8')).toBe('{}');
  expect(await clearCache(dir)).toEqual({ snapshots: 0, bytes: 0 });
  expect(await clearCache(join(dir, 'missing'))).toEqual({
    snapshots: 0,
    bytes: 0,
  });
});

it('reads the cache budget from the environment, defaulting to 500 MB', () => {
  const name = envVar('CACHE_MAX_MB');
  expect(DEFAULT_CACHE_BUDGET_BYTES).toBe(500 * 1024 * 1024);
  expect(cacheBudgetBytes({})).toBe(DEFAULT_CACHE_BUDGET_BYTES);
  expect(cacheBudgetBytes({ [name]: '  ' })).toBe(DEFAULT_CACHE_BUDGET_BYTES);
  expect(cacheBudgetBytes({ [name]: '2' })).toBe(2 * 1024 * 1024);
  for (const bad of ['0', '-5', '1.5', 'lots', '1e3', '9'.repeat(30)])
    expect(() => cacheBudgetBytes({ [name]: bad })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
});

it('reports a cache directory it cannot read instead of treating it as empty', async () => {
  const notADirectory = join(dir, 'file');
  await writeFile(notADirectory, 'x');
  await expect(evictToBudget(notADirectory, 1)).rejects.toMatchObject({
    code: 'ENOTDIR',
  });
});

/** A real directory behind a capacity limit: writes that would exceed it fail with ENOSPC. */
function fullDiskFs(directory: string, capacityBytes: number): CacheFs {
  const used = async (): Promise<number> => {
    let total = 0;
    for (const name of await readdir(directory)) {
      total += (await stat(join(directory, name))).size;
    }
    return total;
  };
  return {
    ...realFs,
    writeFile: (async (
      path: string,
      data: string | Uint8Array,
      options: Parameters<CacheFs['writeFile']>[2],
    ) => {
      const size =
        typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength;
      if ((await used()) + size > capacityBytes)
        throw Object.assign(new Error('no space left on device'), {
          code: 'ENOSPC',
        });
      return realFs.writeFile(path, data, options);
    }) as CacheFs['writeFile'],
  };
}

async function fillCache(
  cacheDir: string,
  count: number,
  size: number,
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const body = new Uint8Array(size).fill(i + 1);
    ids.push(
      await writeCache(
        body,
        { ...metadata, url: `https://example.gov/doc-${String(i)}` },
        cacheDir,
      ),
    );
    await utimes(
      join(cacheDir, ids[i] ?? ''),
      new Date(1000 * (i + 1)),
      new Date(1000 * (i + 1)),
    );
  }
  return ids;
}

it('evicts on a full disk by deleting bytes before it rewrites the index', async () => {
  const cacheDir = join(dir, 'cache');
  const ids = await fillCache(cacheDir, 3, 1000);
  let total = 0;
  for (const name of await readdir(cacheDir))
    total += (await stat(join(cacheDir, name))).size;
  // No headroom at all: any write, such as a replacement index.json, fails.
  const fs = fullDiskFs(cacheDir, total);
  const evicted = await evictToBudget(cacheDir, 1500, ids[2], fs);
  expect(evicted).toEqual([ids[0], ids[1]]);
  expect(
    (await readdir(cacheDir)).filter((n) => /^[a-f0-9]{64}$/.test(n)),
  ).toEqual([ids[2]]);
  // The index could not be rewritten, but its stale entries are plain misses.
  expect(
    await readCache('https://example.gov/doc-0', cacheDir),
  ).toBeUndefined();
  expect(await readCache('https://example.gov/doc-2', cacheDir)).toMatchObject({
    docId: ids[2],
  });
});

it('reclaims space before writing incoming bytes on a full disk', async () => {
  const cacheDir = join(dir, 'cache');
  const ids = await fillCache(cacheDir, 3, 1000);
  let total = 0;
  for (const name of await readdir(cacheDir))
    total += (await stat(join(cacheDir, name))).size;
  const fs = fullDiskFs(cacheDir, total);
  const incoming = new Uint8Array(1500).fill(9);
  const docId = await writeCache(
    incoming,
    { ...metadata, url: 'https://example.gov/new' },
    cacheDir,
    { budgetBytes: 2_400, fs },
  );
  expect(await readCache(docId, cacheDir)).toMatchObject({ docId });
  expect(await readCache(ids[0] ?? '', cacheDir)).toBeUndefined();
  // Without a budget the same write hits ENOSPC.
  await expect(
    writeCache(new Uint8Array(5000).fill(7), metadata, cacheDir, { fs }),
  ).rejects.toMatchObject({ code: 'ENOSPC' });
});
