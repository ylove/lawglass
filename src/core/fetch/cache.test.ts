import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { BRAND } from '../brand.js';
import { defaultCacheDir, documentId, readCache, writeCache } from './cache.js';

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
