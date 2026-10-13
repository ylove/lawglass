import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BRAND } from '../src/core/brand.js';
import { fetchFixtures, parseArguments } from './fetch-fixtures.js';
import type { FixtureManifest } from './fixture-manifest.js';

const data = 'synthetic legislation';
const fixture = {
  name: 'sample-bill',
  description: 'Synthetic bill',
  format: 'text' as const,
  url: 'https://example.com/sample',
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: Buffer.byteLength(data),
  retrievedAt: '2026-10-13',
  jurisdiction: 'Ohio' as const,
  notes: 'Generated test data',
};
const manifest: FixtureManifest = {
  $comment: 'Synthetic test manifest',
  fixtures: [fixture],
};
let directory: string;
const fetcher = vi.fn<typeof fetch>();

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'fixture-download-test-'));
  fetcher
    .mockReset()
    .mockImplementation(() => Promise.resolve(new Response(data)));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function download(
  overrides: Partial<Parameters<typeof fetchFixtures>[0]> = {},
) {
  return fetchFixtures({
    manifest,
    directory,
    version: '1.2.3',
    fetcher,
    ...overrides,
  });
}

test('downloads verified files with the branded user agent and a 60s timeout', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  try {
    expect(await download()).toEqual([
      {
        name: fixture.name,
        status: 'downloaded',
        bytes: fixture.bytes,
        sha256: fixture.sha256,
      },
    ]);
    expect(await readFile(join(directory, 'sample-bill.txt'), 'utf8')).toBe(
      data,
    );
    expect(fetcher).toHaveBeenCalledWith(fixture.url, {
      signal: expect.any(AbortSignal) as unknown,
      headers: { 'User-Agent': `${BRAND.name}-fixtures/1.2.3` },
    });
    expect(timeout).toHaveBeenCalledWith(60_000);
  } finally {
    timeout.mockRestore();
  }
});

test('skips a matching cached file without fetching', async () => {
  await writeFile(join(directory, 'sample-bill.txt'), data);
  expect(await download()).toEqual([
    {
      name: fixture.name,
      status: 'skipped',
      bytes: fixture.bytes,
      sha256: fixture.sha256,
    },
  ]);
  expect(fetcher).not.toHaveBeenCalled();
});

test('replaces a corrupt cached file with a verified download', async () => {
  await writeFile(join(directory, 'sample-bill.txt'), 'corrupt');
  expect(await download()).toMatchObject([{ status: 'downloaded' }]);
  expect(await readFile(join(directory, 'sample-bill.txt'), 'utf8')).toBe(data);
});

test.each(['hash', 'size'])(
  'quarantines a %s mismatch and reports the actual hash and size',
  async (kind) => {
    const received = kind === 'hash' ? data.toUpperCase() : data;
    fetcher.mockResolvedValue(new Response(received));
    const mismatchedManifest = {
      ...manifest,
      fixtures: [
        { ...fixture, bytes: fixture.bytes + (kind === 'size' ? 1 : 0) },
      ],
    };
    const [result] = await download({ manifest: mismatchedManifest });
    const actualHash = createHash('sha256').update(received).digest('hex');
    expect(result).toMatchObject({
      status: 'mismatch',
      sha256: actualHash,
      bytes: Buffer.byteLength(received),
    });
    expect(result?.message).toContain(actualHash);
    expect(result?.message).toContain(
      'update fixtures/manifest.json deliberately',
    );
    expect(await readdir(directory)).toEqual(['sample-bill.txt.mismatch']);
    expect(
      await readFile(join(directory, 'sample-bill.txt.mismatch'), 'utf8'),
    ).toBe(received);
  },
);

test('downloads only named fixtures and rejects unknown names before fetching', async () => {
  const twoFixtures = {
    ...manifest,
    fixtures: [fixture, { ...fixture, name: 'other-bill' }],
  };
  expect(
    await download({ manifest: twoFixtures, only: ['other-bill'] }),
  ).toMatchObject([{ name: 'other-bill', status: 'downloaded' }]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await expect(download({ only: ['unknown'] })).rejects.toThrow(
    'Unknown fixture: unknown',
  );
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test.each(['http', 'timeout', 'body'])(
  'reports %s failures without saving a document and continues',
  async (failure) => {
    const twoFixtures = {
      ...manifest,
      fixtures: [fixture, { ...fixture, name: 'other-bill' }],
    };
    if (failure === 'http')
      fetcher.mockResolvedValueOnce(
        new Response('error page', { status: 503, statusText: 'Unavailable' }),
      );
    if (failure === 'timeout')
      fetcher.mockRejectedValueOnce(
        new DOMException('Request timed out', 'TimeoutError'),
      );
    if (failure === 'body') {
      const response = new Response(data);
      vi.spyOn(response, 'arrayBuffer').mockRejectedValueOnce(
        new Error('Body interrupted'),
      );
      fetcher.mockResolvedValueOnce(response);
    }
    expect(await download({ manifest: twoFixtures })).toMatchObject([
      {
        name: 'sample-bill',
        status: 'error',
        message: expect.stringMatching(/503|timed out|interrupted/) as unknown,
      },
      { name: 'other-bill', status: 'downloaded' },
    ]);
    expect(await readdir(directory)).toEqual(['other-bill.txt']);
  },
);

test('creates the download directory when absent', async () => {
  expect(
    await download({ directory: join(directory, 'nested') }),
  ).toMatchObject([{ status: 'downloaded' }]);
});

test('parses the optional comma-separated selection', () => {
  expect(parseArguments([])).toBeUndefined();
  expect(parseArguments(['--only', 'sample-bill, other-bill'])).toEqual([
    'sample-bill',
    'other-bill',
  ]);
});
test.each([
  ['--only'],
  ['--only', ''],
  ['--only', 'a,'],
  ['--bad', 'a'],
  ['--only', 'a', 'extra'],
])('rejects invalid CLI arguments: %j', (...args) => {
  expect(() => parseArguments(args)).toThrow();
});

test('the CLI exits nonzero with a clear message for an unknown fixture', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'tsx',
      'scripts/fetch-fixtures.ts',
      '--only',
      'unknown-fixture',
    ],
    { encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Unknown fixture: unknown-fixture');
});
