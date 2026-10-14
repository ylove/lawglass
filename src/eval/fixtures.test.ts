import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { memoryFetcher, readDownloadedFixture } from './fixtures.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-fixtures-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('memoryFetcher serves bytes with a matching docId and rejects unknown urls', async () => {
  const bytes = new TextEncoder().encode('<html><body><p>x</p></body></html>');
  const fetcher = memoryFetcher([
    {
      name: 'a',
      url: 'https://x.test/a.html',
      bytes,
      contentType: 'text/html',
    },
  ]);
  const result = await fetcher('https://x.test/a.html');
  expect(result.format).toBe('html');
  expect(result.docId).toMatch(/^[a-f0-9]{64}$/);
  expect(result.bytes).toBe(bytes);
  await expect(fetcher('https://x.test/other')).rejects.toMatchObject({
    code: 'FETCH_FAILED',
  });
});

test('readDownloadedFixture reads a manifest entry from downloads/', async () => {
  await mkdir(join(dir, 'downloads'));
  await writeFile(
    join(dir, 'manifest.json'),
    JSON.stringify({
      fixtures: [
        { name: 'plain', format: 'text' },
        { name: 'absent', format: 'xml' },
      ],
    }),
  );
  await writeFile(
    join(dir, 'downloads', 'plain.txt'),
    'Section 1. Title\nBody.',
  );

  const found = await readDownloadedFixture(dir, 'plain');
  expect(found.fixture?.contentType).toBe('text/plain');
  expect(found.fixture?.url).toMatch(/^file:\/\/.*plain\.txt$/);
  expect(new TextDecoder().decode(found.fixture?.bytes)).toContain('Body.');

  expect((await readDownloadedFixture(dir, 'absent')).missing).toContain(
    'not downloaded',
  );
  expect((await readDownloadedFixture(dir, 'unlisted')).missing).toContain(
    'not listed',
  );
});

test('a missing or invalid manifest is reported, not thrown', async () => {
  expect((await readDownloadedFixture(dir, 'x')).missing).toContain('manifest');
  await writeFile(join(dir, 'manifest.json'), '{"fixtures": 3}');
  expect((await readDownloadedFixture(dir, 'x')).missing).toContain('manifest');
});
