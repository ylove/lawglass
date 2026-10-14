import { expect, test, vi } from 'vitest';
import { makeOhioHistoryPages } from '../tests/synth/ohio-history.js';
import { documentId, type SafeFetchResult } from '../src/core/fetch/index.js';
import { runHistoryCanary } from './history-canary.js';

const fixture = {
  name: 'oh-synthetic',
  jurisdiction: 'Ohio' as const,
  url: 'https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/00_IN/pdf/',
};
const pages = makeOhioHistoryPages();
function serve(url: string): Promise<SafeFetchResult> {
  const kind = url.split('/').at(-1) as keyof typeof pages;
  const bytes = new TextEncoder().encode(pages[kind]);
  return Promise.resolve({
    bytes,
    docId: documentId(bytes),
    finalUrl: url,
    contentType: 'text/html',
    format: 'html',
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
        '7 versions (latest 06_EN), 10 actions, 1 amendments, 4 sponsors/cosponsors',
    },
  ]);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
    ['status', 'documents', 'committee'].map(
      (kind) =>
        `https://www.legislature.ohio.gov/legislation/135/hb9001/${kind}`,
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
    detail: 'History unavailable: download or parser check failed.',
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
    finalUrl: 'https://ohiohouse.gov/members/example',
  });
  expect((await runHistoryCanary([fixture], redirected))[0]!.ok).toBe(false);
});
