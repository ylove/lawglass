import { expect, test, vi } from 'vitest';
import { makeOhioHistoryJson } from '../tests/synth/ohio-history.js';
import { documentId, type SafeFetchResult } from '../src/core/fetch/index.js';
import { runHistoryCanary } from './history-canary.js';

const fixture = {
  name: 'oh-synthetic',
  jurisdiction: 'Ohio' as const,
  url: 'https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/00_IN/pdf/',
};
const json = makeOhioHistoryJson();
const bodies: Record<string, string> = {
  hb9001: json.versions,
  actions: json.actions,
  meetings: json.meetings,
  amendments: json.amendments,
};
function serve(url: string): Promise<SafeFetchResult> {
  const bytes = new TextEncoder().encode(
    bodies[url.split('/').filter(Boolean).at(-1) ?? ''] ?? '[]',
  );
  return Promise.resolve({
    bytes,
    docId: documentId(bytes),
    finalUrl: url,
    contentType: 'application/json',
    format: 'unknown',
    fromCache: false,
  });
}
test('canary checks Ohio fixture history through injected fetches and skips other jurisdictions', async () => {
  const fetcher = vi.fn(serve);
  const result = await runHistoryCanary(
    [fixture, { ...fixture, name: 'federal', jurisdiction: 'US Congress' }],
    fetcher,
    () => new Date('2026-10-14T00:00:00.000Z'),
  );
  expect(result).toEqual([
    {
      name: fixture.name,
      ok: true,
      detail:
        '7 versions (latest 06_EN), 8 actions, 0 amendments, 4 sponsors/cosponsors',
    },
  ]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
    ['', 'actions/', 'meetings/', 'amendments/'].map(
      (path) =>
        `https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/${path}`,
    ),
  );
});
test('canary continues after a failed fixture without leaking transport details', async () => {
  const fetcher = vi
    .fn(serve)
    .mockRejectedValueOnce(new Error('private details'));
  const result = await runHistoryCanary(
    [fixture, { ...fixture, name: 'next' }],
    fetcher,
  );
  expect(result[0]).toEqual({
    name: fixture.name,
    ok: false,
    detail: 'History unavailable: API request or validation failed.',
  });
  expect(result[1]!.ok).toBe(true);
});
test('canary fails for unknown URLs, unlisted fixture versions and off-host redirects', async () => {
  for (const url of [
    'https://example.gov/bill',
    fixture.url.replace('00_IN', '99_XX'),
  ])
    expect((await runHistoryCanary([{ ...fixture, url }], serve))[0]!.ok).toBe(
      false,
    );
  const redirected = async (url: string) => ({
    ...(await serve(url)),
    finalUrl: 'https://www.legislature.ohio.gov/legislation/135/hb9001',
  });
  expect((await runHistoryCanary([fixture], redirected))[0]!.ok).toBe(false);
});
