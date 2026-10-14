import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configFileSystem } from '../config-files.js';
import { AppError } from '../model/index.js';
import type { Fetcher } from '../pipeline/index.js';
import {
  LEGISLATORS_CACHE_TTL_MS,
  LEGISLATORS_URLS,
  loadLegislators,
  type LegislatorsOptions,
} from './legislators.js';
import { enrichSponsorLinks } from './links.js';

// These are invented people; no downloaded directory or network is used.
const CURRENT = [
  {
    id: {
      bioguide: 'A000001',
      wikipedia: 'Alex Adams (Ohio)',
      ballotpedia: 'Alex Adams (Ohio)',
      govtrack: 1,
    },
    name: { first: 'Alex', last: 'Adams' },
    bio: { gender: 'X' },
    terms: [
      {
        start: '2025-01-03',
        end: '2027-01-03',
        state: 'OH',
        url: 'https://alex-adams.house.gov',
      },
      {
        start: '2021-01-03',
        end: '2023-01-03',
        url: 'http://old-adams.house.gov',
      },
    ],
  },
  {
    id: {
      bioguide: 'A000002',
      wikipedia: 'Blair Adams',
      ballotpedia: 'Blair Adams',
    },
    name: { first: 'Blair', last: 'Adams' },
    terms: [{ start: '2025-01-03', url: 'http://blair-adams.senate.gov' }],
  },
];
const HISTORICAL = [
  {
    id: {
      bioguide: 'A000003',
      wikipedia: 'Alex Adams (Maine)',
      ballotpedia: 'Alex Adams (Maine)',
    },
    name: { first: 'Alex', last: 'Adams' },
    terms: [
      {
        start: '2017-01-03',
        state: 'ME',
        url: 'https://alex-adams.senate.gov',
      },
    ],
  },
];
const NOW = new Date('2026-10-14T12:00:00.000Z');

function response(value: unknown, url: string = LEGISLATORS_URLS.current) {
  return {
    docId: 'a'.repeat(64),
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    finalUrl: url,
    contentType: 'application/json',
    format: 'text' as const,
    fromCache: false,
  };
}

describe('loadLegislators', () => {
  let configDir: string;
  let fetcher: ReturnType<typeof vi.fn<Fetcher>>;
  let options: LegislatorsOptions;
  const cachePath = (source = 'current') =>
    join(configDir, 'sponsors', `legislators-${source}.json`);

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), 'sponsor-directory-'));
    fetcher = vi.fn<Fetcher>((url) =>
      Promise.resolve(
        response(url === LEGISLATORS_URLS.current ? CURRENT : HISTORICAL, url),
      ),
    );
    options = { fetcher, configDir, now: () => NOW };
  });

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true });
  });

  it('fetches only current for known ids, projects minimal fields, and writes private JSON', async () => {
    const result = await loadLegislators(['A000001', 'A000002'], options);
    expect([...result]).toEqual([
      [
        'A000001',
        {
          officialUrl: 'https://alex-adams.house.gov/',
          wikipedia: 'Alex Adams (Ohio)',
          ballotpedia: 'Alex Adams (Ohio)',
        },
      ],
      [
        'A000002',
        {
          officialUrl: 'https://blair-adams.senate.gov/',
          wikipedia: 'Blair Adams',
          ballotpedia: 'Blair Adams',
        },
      ],
    ]);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(LEGISLATORS_URLS.current, {
      signal: undefined,
    });
    const cached = JSON.parse(await readFile(cachePath(), 'utf8')) as unknown;
    expect(cached).toEqual({
      version: 1,
      fetchedAt: NOW.toISOString(),
      legislators: Object.fromEntries(result),
    });
    if (process.platform !== 'win32') {
      expect((await stat(cachePath())).mode & 0o777).toBe(0o600);
      expect((await stat(join(configDir, 'sponsors'))).mode & 0o777).toBe(
        0o700,
      );
    }
  });

  it('loads historical only for missing ids and keeps identical full names in different states separate', async () => {
    const directory = await loadLegislators(['A000001', 'A000003'], options);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      LEGISLATORS_URLS.current,
      LEGISLATORS_URLS.historical,
    ]);
    const enriched = enrichSponsorLinks(
      [
        {
          name: 'Alex Adams',
          state: 'OH',
          role: 'sponsor',
          bioguideId: 'A000001',
          links: [],
        },
        {
          name: 'Alex Adams',
          state: 'ME',
          role: 'cosponsor',
          bioguideId: 'A000003',
          links: [],
        },
      ],
      directory,
    );
    expect(
      enriched[0]!.links.find((l) => l.kind === 'wikipedia')!.url,
    ).toContain('Alex_Adams_(Ohio)');
    expect(
      enriched[1]!.links.find((l) => l.kind === 'wikipedia')!.url,
    ).toContain('Alex_Adams_(Maine)');
  });

  it('keeps current data when sources overlap', async () => {
    fetcher.mockResolvedValueOnce(response(CURRENT)).mockResolvedValueOnce(
      response(
        [CURRENT[0], ...HISTORICAL].map((member) => ({
          ...member,
          id: { ...member!.id, wikipedia: 'Outdated title' },
        })),
      ),
    );
    const result = await loadLegislators(['A000001', 'A000003'], options);
    expect(result.get('A000001')!.wikipedia).toBe('Alex Adams (Ohio)');
  });

  it('uses both private caches for seven days, including negative lookups', async () => {
    const first = await loadLegislators(['A999999'], options);
    fetcher.mockClear();
    const result = await loadLegislators(['A999999'], {
      ...options,
      now: () => new Date(NOW.getTime() + LEGISLATORS_CACHE_TTL_MS - 1),
    });
    expect(result).toEqual(first);
    expect(result.has('A999999')).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    const searches = enrichSponsorLinks(
      [
        {
          name: 'Alex Adams',
          role: 'sponsor',
          bioguideId: 'A999999',
          links: [],
        },
      ],
      result,
    );
    expect(
      searches[0]!.links.every((l) => l.kind === 'search' && !l.verified),
    ).toBe(true);
  });

  it('expires caches at exactly seven days', async () => {
    await loadLegislators(['A000003'], options);
    fetcher.mockClear();
    await loadLegislators(['A000003'], {
      ...options,
      now: () => new Date(NOW.getTime() + LEGISLATORS_CACHE_TTL_MS),
    });
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      LEGISLATORS_URLS.current,
      LEGISLATORS_URLS.historical,
    ]);
    expect(JSON.parse(await readFile(cachePath(), 'utf8'))).toMatchObject({
      fetchedAt: new Date(
        NOW.getTime() + LEGISLATORS_CACHE_TTL_MS,
      ).toISOString(),
    });
  });

  it('loads historical later without refreshing a fresh current cache', async () => {
    await loadLegislators(['A000001'], options);
    fetcher.mockClear();
    await loadLegislators(['A000003'], options);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      LEGISLATORS_URLS.historical,
      { signal: undefined },
    );
  });

  it.each([
    '{broken JSON',
    JSON.stringify({
      version: 99,
      fetchedAt: NOW.toISOString(),
      legislators: {},
    }),
    JSON.stringify({
      version: 1,
      fetchedAt: NOW.toISOString(),
      legislators: { A000001: { officialUrl: 'not a URL' } },
    }),
    JSON.stringify({
      version: 1,
      fetchedAt: NOW.toISOString(),
      legislators: { A000001: { wikipedia: 'Alex', name: 'unneeded' } },
    }),
    JSON.stringify({ version: 1, fetchedAt: 'invalid date', legislators: {} }),
    JSON.stringify({
      version: 1,
      fetchedAt: new Date(NOW.getTime() + 1).toISOString(),
      legislators: { A000001: {} },
    }),
  ])('replaces a malformed or future-dated cache: %s', async (contents) => {
    await loadLegislators(['A000001'], options);
    await writeFile(cachePath(), contents);
    fetcher.mockClear();
    const result = await loadLegislators(['A000001'], options);
    expect(result.get('A000001')!.wikipedia).toBe('Alex Adams (Ohio)');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.skipIf(process.platform === 'win32')(
    'replaces a group-readable cache instead of trusting it',
    async () => {
      await loadLegislators(['A000001'], options);
      await chmod(cachePath(), 0o644);
      fetcher.mockClear();
      await loadLegislators(['A000001'], options);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect((await stat(cachePath())).mode & 0o777).toBe(0o600);
    },
  );

  it.each(
    [[], [''], ['Alex Adams'], ['a000001'], ['../current']].map((ids) => ({
      ids,
    })),
  )('does not fetch without usable bioguide ids: $ids', async ({ ids }) => {
    expect(await loadLegislators(ids, options)).toEqual(new Map());
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('passes cancellation to the fetcher and rejects an already aborted signal even with a cache', async () => {
    const controller = new AbortController();
    await loadLegislators(['A000001'], {
      ...options,
      signal: controller.signal,
    });
    expect(fetcher.mock.calls[0]![1]!.signal).toBe(controller.signal);
    controller.abort();
    await expect(
      loadLegislators(['A000001'], { ...options, signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('propagates fetch failures without writing a cache', async () => {
    const failure = new AppError('FETCH_FAILED');
    fetcher.mockRejectedValueOnce(failure);
    await expect(loadLegislators(['A000001'], options)).rejects.toBe(failure);
    await expect(stat(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a good current cache intact if historical fails', async () => {
    fetcher
      .mockResolvedValueOnce(response(CURRENT))
      .mockRejectedValueOnce(new AppError('FETCH_TIMEOUT'));
    await expect(loadLegislators(['A000003'], options)).rejects.toMatchObject({
      code: 'FETCH_TIMEOUT',
    });
    fetcher.mockClear();
    const current = await loadLegislators(['A000001'], options);
    expect(current.get('A000001')).toBeDefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    {},
    [{ id: { bioguide: 'not-an-id' }, terms: [] }],
    [{ id: { bioguide: 'A000001', wikipedia: 2 }, terms: [] }],
    [{ id: { bioguide: 'A000001' }, terms: [{ start: '2025-99-01' }] }],
    [
      {
        id: { bioguide: 'A000001' },
        terms: [{ start: '2025-01-03', url: 'not-a-url' }],
      },
    ],
    [CURRENT[0], CURRENT[0]],
  ])('rejects invalid source data without caching: %j', async (source) => {
    fetcher.mockResolvedValueOnce(response(source));
    await expect(loadLegislators(['A000001'], options)).rejects.toMatchObject({
      code: 'PARSE_FAILED',
    });
    await expect(stat(cachePath())).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed JSON with a safe error message', async () => {
    fetcher.mockResolvedValueOnce({
      ...response([]),
      bytes: new TextEncoder().encode('secret-invalid-json'),
    });
    await expect(loadLegislators(['A000001'], options)).rejects.toMatchObject({
      code: 'PARSE_FAILED',
      message: 'Invalid legislators directory JSON.',
    });
  });

  it('skips members without ids and does not substitute an older term URL for a missing latest URL', async () => {
    fetcher.mockResolvedValueOnce(
      response([
        { id: {}, terms: [] },
        {
          id: { bioguide: 'A000001' },
          terms: [
            { start: '2020-01-03', url: 'https://old.house.gov' },
            { start: '2025-01-03' },
          ],
        },
        { id: { bioguide: 'A000002' }, terms: [] },
      ]),
    );
    expect([...(await loadLegislators(['A000001'], options))]).toEqual([
      ['A000001', {}],
      ['A000002', {}],
    ]);
  });

  it.each([
    'https://campaign.example/',
    'https://example.house.gov.evil.example/',
    'https://nothouse.gov/',
    'https://name:password@example.house.gov/',
    'https://example.senate.gov:8443/',
    'ftp://example.house.gov/',
  ])('does not retain non-official or unsafe term URL %s', async (url) => {
    fetcher.mockResolvedValueOnce(
      response([
        { id: { bioguide: 'A000001' }, terms: [{ start: '2025-01-03', url }] },
      ]),
    );
    expect(
      (await loadLegislators(['A000001'], options)).get('A000001'),
    ).toEqual({});
  });

  it('reports a cache write failure without leaking filesystem details', async () => {
    const fs = {
      ...configFileSystem,
      mkdir: vi.fn().mockRejectedValue(new Error('sensitive filesystem error')),
    };
    await expect(
      loadLegislators(['A000001'], { ...options, fs }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'The local data file could not be saved.',
    });
  });
});
