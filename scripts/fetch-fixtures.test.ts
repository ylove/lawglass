import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BRAND } from '../src/core/brand.js';
import {
  BYTE_SLACK,
  fetchFixtures,
  parseArguments,
  readWithBudget,
} from './fetch-fixtures.js';
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
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error('Body interrupted'));
        },
      });
      fetcher.mockResolvedValueOnce(new Response(body));
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

test('writes atomically: no .part file remains after a download', async () => {
  expect(await download()).toMatchObject([{ status: 'downloaded' }]);
  expect(await readdir(directory)).toEqual(['sample-bill.txt']);
});

test('refuses a body whose Content-Length is far larger than expected', async () => {
  fetcher.mockResolvedValue(
    new Response(data, {
      headers: { 'content-length': String(fixture.bytes + BYTE_SLACK + 1) },
    }),
  );
  const [result] = await download();
  expect(result?.status).toBe('error');
  expect(result?.message).toContain('far larger');
  expect(await readdir(directory)).toEqual([]);
});

// C7: the manifest's byte count is the download budget, enforced while streaming.
function endlessBody(chunk: Uint8Array): {
  response: Response;
  pulled: () => number;
  cancelled: () => boolean;
} {
  let pulls = 0;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls++;
      controller.enqueue(chunk);
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(body),
    pulled: () => pulls,
    cancelled: () => cancelled,
  };
}

test('stops reading an unbounded body at the manifest budget, without a Content-Length', async () => {
  const chunk = new Uint8Array(16 * 1024);
  const { response, pulled, cancelled } = endlessBody(chunk);
  fetcher.mockResolvedValueOnce(response);
  const [result] = await download();
  expect(result).toMatchObject({ name: fixture.name, status: 'error' });
  expect(result?.message).toContain('budget');
  expect(cancelled()).toBe(true);
  // The budget is the manifest size plus slack; the stream must not have been drained far past it.
  expect(pulled() * chunk.byteLength).toBeLessThan(
    fixture.bytes + BYTE_SLACK + 4 * chunk.byteLength,
  );
  expect(await readdir(directory)).toEqual([]);
});

test('a slightly larger re-render within the slack still downloads and is reported as a mismatch', async () => {
  const grown = `${data} and a few more bytes`;
  fetcher.mockResolvedValueOnce(new Response(grown));
  const [result] = await download();
  expect(result?.status).toBe('mismatch');
  expect(await readdir(directory)).toEqual(['sample-bill.txt.mismatch']);
});

test('a body exactly at the budget is read in full and an empty body reads as empty', async () => {
  const exact = new Uint8Array(100).fill(7);
  expect(await readWithBudget(new Response(exact), 100)).toEqual(exact);
  await expect(readWithBudget(new Response(exact), 99)).rejects.toThrow(
    /budget/,
  );
  expect(await readWithBudget(new Response(null), 10)).toEqual(
    new Uint8Array(),
  );
});

test('the announced length is checked against the budget before any byte is read', async () => {
  const { response, pulled, cancelled } = endlessBody(new Uint8Array(1024));
  Object.defineProperty(response, 'headers', {
    value: new Headers({ 'content-length': '999999999' }),
  });
  await expect(readWithBudget(response, 1000)).rejects.toThrow(/budget/);
  expect(cancelled()).toBe(true);
  expect(pulled()).toBeLessThanOrEqual(1);
});

test('downloads and reuses content-pinned HTML despite transport changes, but saves changed text for review', async () => {
  const { normalizedFixtureSha256 } =
    await import('../src/eval/fixture-integrity.js');
  const html =
    '<article><h1>Section 1. Notices.</h1><p>Each steward shall send a notice.</p></article>';
  const pinned = {
    ...fixture,
    format: 'html' as const,
    normalizedTextSha256: await normalizedFixtureSha256(Buffer.from(html), {
      format: 'html',
      url: fixture.url,
    }),
  };
  const contentManifest = { ...manifest, fixtures: [pinned] };
  fetcher.mockResolvedValueOnce(
    new Response(`<script src="cache-12345.js"></script>${html}`),
  );
  expect(await download({ manifest: contentManifest })).toMatchObject([
    { status: 'downloaded' },
  ]);
  fetcher.mockClear();
  expect(await download({ manifest: contentManifest })).toMatchObject([
    { status: 'skipped', sha256: pinned.normalizedTextSha256 },
  ]);
  expect(fetcher).not.toHaveBeenCalled();
  await writeFile(
    join(directory, 'sample-bill.html'),
    html.replace('steward', 'farmer'),
  );
  fetcher.mockResolvedValueOnce(
    new Response(html.replace('steward', 'farmer')),
  );
  const result = await download({ manifest: contentManifest });
  expect(result).toMatchObject([{ status: 'mismatch' }]);
  expect(result[0]?.message).toContain('normalized text sha256');
  expect(
    await readFile(join(directory, 'sample-bill.html.mismatch'), 'utf8'),
  ).toContain('farmer');
});
