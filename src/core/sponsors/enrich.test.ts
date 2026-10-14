import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AppError,
  EMPTY_METADATA,
  type NormalizedDoc,
} from '../model/index.js';
import type { Fetcher } from '../pipeline/index.js';
import { LEGISLATORS_URLS } from './legislators.js';
import { withSponsorLinks } from './enrich.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'sponsor-enrich-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const doc = (metadata: Partial<NormalizedDoc['metadata']>): NormalizedDoc => ({
  docId: 'a'.repeat(64),
  sourceUrl: 'https://example.gov/x',
  format: 'text',
  fetchedAt: '2026-10-14T00:00:00.000Z',
  metadata: { ...EMPTY_METADATA, ...metadata },
  sections: [],
  definitions: [],
  externalRefs: [],
  warnings: [],
});

const directoryBytes = new TextEncoder().encode(
  JSON.stringify([
    {
      id: { bioguide: 'X000001', wikipedia: 'Alex Example' },
      terms: [{ start: '2023-01-03', url: 'https://example.house.gov' }],
    },
  ]),
);
const respond = (bytes: Uint8Array): ReturnType<Fetcher> =>
  Promise.resolve({
    docId: 'd',
    bytes,
    finalUrl: 'https://unitedstates.github.io/x',
    contentType: 'application/json',
    format: 'text',
    fromCache: false,
  });
const context = (fetcher: Fetcher, signal?: AbortSignal) => ({
  fetcher,
  configDir: dir,
  now: () => new Date('2026-10-14T00:00:00.000Z'),
  signal,
});
const official = {
  name: 'Rep. Example',
  role: 'sponsor' as const,
  bioguideId: 'X000001',
  links: [],
};

describe('withSponsorLinks', () => {
  it('joins record profiles by bioguide id, bypassing the raw cache and allowlisting the URL', async () => {
    const fetcher = vi.fn<Fetcher>(() => respond(directoryBytes));
    const out = await withSponsorLinks(
      doc({ sponsorProfiles: [official] }),
      context(fetcher),
      { fromRecord: true },
    );
    expect(out.metadata.sponsorProfiles?.[0]?.links[0]).toMatchObject({
      kind: 'official',
      verified: true,
    });
    const [url, options] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe(LEGISLATORS_URLS.current);
    expect(options?.refresh).toBe(true);
    expect(() =>
      options?.validateUrl?.(new URL('https://evil.test/x')),
    ).toThrow(AppError);
    expect(() =>
      options?.validateUrl?.(new URL(LEGISLATORS_URLS.current)),
    ).not.toThrow();
  });

  it('keeps the profiles unchanged when the directory cannot be read', async () => {
    const original = doc({ sponsorProfiles: [official] });
    const out = await withSponsorLinks(
      original,
      context(() => Promise.reject(new AppError('FETCH_FAILED'))),
      { fromRecord: true },
    );
    expect(out).toBe(original);
  });

  it('rethrows when the failure is an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      withSponsorLinks(
        doc({ sponsorProfiles: [official] }),
        context(() => Promise.reject(new Error('x')), controller.signal),
        { fromRecord: true },
      ),
    ).rejects.toThrow();
  });

  it('builds search-only profiles from names when there is no official record', async () => {
    const fetcher = vi.fn<Fetcher>();
    const out = await withSponsorLinks(
      doc({ sponsors: ['Jane Roe'], jurisdiction: 'Ohio' }),
      context(fetcher),
      { fromRecord: false },
    );
    expect(fetcher).not.toHaveBeenCalled();
    const profile = out.metadata.sponsorProfiles?.[0];
    expect(profile?.name).toBe('Jane Roe');
    expect(
      profile?.links.every((l) => l.kind === 'search' && !l.verified),
    ).toBe(true);
    expect(profile?.links[0]?.url).toContain('Jane%20Roe%20Ohio');
  });

  it('does nothing without sponsors, or when profiles already exist and there is no new record', async () => {
    const fetcher = vi.fn<Fetcher>();
    const bare = doc({});
    expect(
      await withSponsorLinks(bare, context(fetcher), { fromRecord: false }),
    ).toBe(bare);
    const done = doc({ sponsorProfiles: [official] });
    expect(
      await withSponsorLinks(done, context(fetcher), { fromRecord: false }),
    ).toBe(done);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
