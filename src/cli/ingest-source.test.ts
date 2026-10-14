import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { documentId } from '../core/fetch/index.js';
import { prepareIngestSource } from './ingest-source.js';

let dir: string;
const network = vi.fn(() =>
  Promise.reject(new Error('Network must not be used')),
);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-source-'));
  network.mockClear();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function file(name = 'bill.txt') {
  const path = join(dir, name);
  await writeFile(path, 'Section 1. Grants\nTowns may apply.');
  return path;
}

test.each([
  'http://example.gov/bill',
  'https://example.gov/bill',
  'HTTPS://example.gov/bill',
])('HTTP source %s keeps the injected network fetcher', async (input) => {
  expect(await prepareIngestSource(input, network, [])).toEqual({
    fetcher: network,
  });
  expect(network).not.toHaveBeenCalled();
});

test('file URLs use a decoded filename and a captured snapshot', async () => {
  const path = await file('bill #1 ü.txt');
  const source = await prepareIngestSource(
    pathToFileURL(path).href,
    network,
    [],
  );
  const first = await source.fetcher(path);
  await writeFile(path, 'Changed after selection.');
  expect(await source.fetcher(path)).toEqual(first);
  expect(source.label).toBe('bill #1 ü.txt');
  expect(network).not.toHaveBeenCalled();
});

test('known content keeps its existing label', async () => {
  const path = await file();
  const docId = documentId(
    new TextEncoder().encode('Section 1. Grants\nTowns may apply.'),
  );
  const source = await prepareIngestSource(path, network, [
    { docId, label: 'my-label' },
  ]);
  expect(source.label).toBe('my-label');
});

test('colliding filenames get bounded unique labels, including suffix collisions', async () => {
  const path = await file(`${'x'.repeat(100)}.txt`);
  const hash = documentId(
    new TextEncoder().encode('Section 1. Grants\nTowns may apply.'),
  ).slice(0, 6);
  const base = 'x'.repeat(80);
  const suffix = ` (${hash})`;
  const source = await prepareIngestSource(path, network, [
    { docId: 'a'.repeat(64), label: base },
    {
      docId: 'b'.repeat(64),
      label: `${base.slice(0, 80 - suffix.length)}${suffix}`,
    },
  ]);
  expect(source.label).toHaveLength(80);
  expect(source.label).toMatch(new RegExp(`\\(${hash}-2\\)$`));
});

test('whitespace-only filenames fall back to a content id prefix', async () => {
  const source = await prepareIngestSource(await file('   '), network, []);
  expect(source.label).toMatch(/^[a-f0-9]{12}$/);
});

test.each([
  'ftp://example.gov/bill',
  'mailto:bill@example.gov',
  'data:text/plain,bill',
])('unsupported URL %s is invalid and never fetched', async (input) => {
  await expect(prepareIngestSource(input, network, [])).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(network).not.toHaveBeenCalled();
});

test('an existing filename containing a colon is still a file', async () => {
  const name = `bill:${Date.now().toString()}.txt`;
  // A bare name with a URL-like scheme is resolved relative to the CLI working directory.
  await writeFile(name, 'Section 1. Grants\nTowns may apply.');
  try {
    const source = await prepareIngestSource(name, network, []);
    expect(source.label).toBe(name);
  } finally {
    await rm(name);
  }
});

test('missing files produce the file error without touching the network', async () => {
  await expect(
    prepareIngestSource(join(dir, 'missing.txt'), network, []),
  ).rejects.toMatchObject({
    userMessage: expect.stringContaining('could not be found') as string,
  });
  expect(network).not.toHaveBeenCalled();
});
