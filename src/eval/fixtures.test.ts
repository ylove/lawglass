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

test.each([false, true])(
  'eval verifies downloaded fingerprints (content pin: %s)',
  async (contentPin) => {
    const { createHash } = await import('node:crypto');
    const { normalizedFixtureSha256 } = await import('./fixture-integrity.js');
    const html =
      '<article><h1>Section 1. Notices.</h1><p>Each steward shall send a notice.</p></article>';
    const entry = {
      name: 'pinned',
      format: 'html' as const,
      url: 'https://example.gov/bill.html',
      sha256: createHash('sha256').update(html).digest('hex'),
      bytes: Buffer.byteLength(html),
      ...(contentPin
        ? {
            normalizedTextSha256: await normalizedFixtureSha256(
              Buffer.from(html),
              { format: 'html', url: 'https://example.gov/bill.html' },
            ),
          }
        : {}),
    };
    await mkdir(join(dir, 'downloads'));
    await writeFile(
      join(dir, 'manifest.json'),
      JSON.stringify({ fixtures: [entry] }),
    );
    const path = join(dir, 'downloads', 'pinned.html');
    await writeFile(path, html);
    expect((await readDownloadedFixture(dir, 'pinned')).fixture).toBeDefined();
    await writeFile(path, `<script src="cache-12345.js"></script>${html}`);
    expect(Boolean((await readDownloadedFixture(dir, 'pinned')).fixture)).toBe(
      contentPin,
    );
    await writeFile(path, html.replace('steward', 'farmer'));
    expect((await readDownloadedFixture(dir, 'pinned')).missing).toContain(
      'fingerprint mismatch',
    );
  },
);
