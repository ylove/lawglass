import { expect, it, vi } from 'vitest';
import { documentId, type SafeFetchResult } from '../fetch/index.js';
import type { BillHistory } from '../model/index.js';
import type { Fetcher } from '../pipeline/ingest.js';
import { Limits } from '../pipeline/limits.js';
import {
  assertVersionUrl,
  locateVersions,
  versionOverlap,
  MAX_VERSION_BYTES,
  MAX_VERSIONS,
} from './versions.js';

const history = (urls: string[]): BillHistory => ({
  versions: urls.map((url, i) => ({
    url,
    code: String(i),
    label: `Version ${String(i)}`,
    date: '2025-05-01',
  })),
  sources: [],
  actions: [],
  amendments: [],
});
const url = (i: number) => `https://www.govinfo.gov/version-${String(i)}.txt`;
function fetched(
  text = 'Section 1. Grants\nGarden grants support school gardens.',
): SafeFetchResult {
  const bytes = new TextEncoder().encode(text);
  return {
    docId: documentId(bytes),
    finalUrl: url(0),
    bytes,
    contentType: 'text/plain',
    format: 'text',
    fromCache: false,
  };
}
it('measures distinct content words in a local window, not scattered through the bill', () => {
  expect(
    versionOverlap('the garden grants', 'Garden grants support schools.')
      .overlap,
  ).toBe(1);
  expect(versionOverlap('garden grants', 'Garden funding.').overlap).toBe(0.5);
  expect(versionOverlap('the and bill', 'Anything')).toEqual({ overlap: 0 });
  expect(versionOverlap('garden grants', 'unrelated')).toEqual({ overlap: 0 });
  expect(
    versionOverlap('garden grants', `garden ${'filler '.repeat(110)}grants`)
      .overlap,
  ).toBe(0.5);
  expect(versionOverlap('garden garden grants', 'Garden grants.').overlap).toBe(
    1,
  );
});
it('returns unavailable without fetching when no allowlisted versions exist', async () => {
  const fetcher = vi.fn<Fetcher>();
  expect(await locateVersions('garden grants', undefined, { fetcher })).toEqual(
    { status: 'unavailable', versions: [] },
  );
  expect(
    (
      await locateVersions(
        'garden grants',
        history(['https://evil.gov/v', 'https://www.govinfo.gov.evil/v']),
        { fetcher },
      )
    ).status,
  ).toBe('unavailable');
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([
  'http://www.govinfo.gov/x',
  'https://x@www.govinfo.gov/x',
  'https://www.govinfo.gov:8443/x',
  'https://evil.gov/x',
])('rejects unsafe versions %s', (value) => {
  expect(() => {
    assertVersionUrl(new URL(value));
  }).toThrow();
});
it('caps versions, deduplicates URLs, passes streaming byte limits, and caches parsed text', async () => {
  const commit = vi.fn(() => Promise.resolve());
  const fetcher = vi.fn<Fetcher>((u, opts) => {
    expect(opts?.maxBytes).toBe(MAX_VERSION_BYTES);
    expect(() => {
      opts?.validateUrl?.(new URL('https://evil.gov/redirect'));
    }).toThrow();
    return Promise.resolve({ ...fetched(), finalUrl: u, commitCache: commit });
  });
  const result = await locateVersions(
    'garden grants',
    history([url(0), ...Array.from({ length: 9 }, (_, i) => url(i))]),
    { fetcher },
  );
  expect(fetcher).toHaveBeenCalledTimes(MAX_VERSIONS);
  expect(commit).toHaveBeenCalledTimes(MAX_VERSIONS);
  expect(result.versions).toHaveLength(MAX_VERSIONS);
  expect(result.versions[0]).toMatchObject({
    label: 'Version 0',
    date: '2025-05-01',
    overlap: 1,
  });
});
it('caps total bytes and rejects oversize responses even from injected fetchers', async () => {
  const fetcher = vi.fn<Fetcher>((u) =>
    Promise.resolve({
      ...fetched(),
      finalUrl: u,
      bytes: new Uint8Array(MAX_VERSION_BYTES + 1),
    }),
  );
  expect(
    (
      await locateVersions(
        'garden grants',
        history(Array.from({ length: 5 }, (_, i) => url(i))),
        { fetcher },
      )
    ).status,
  ).toBe('unavailable');
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('revalidates the final URL and honors the hosted ingest policy before fetching', async () => {
  const fetcher = vi.fn<Fetcher>(() =>
    Promise.resolve({ ...fetched(), finalUrl: 'https://evil.gov/file' }),
  );
  expect(
    (await locateVersions('garden grants', history([url(0)]), { fetcher }))
      .status,
  ).toBe('unavailable');
  fetcher.mockClear();
  await locateVersions('garden grants', history([url(0)]), {
    fetcher,
    validateUrl: () => {
      throw new Error('policy');
    },
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('uses the shared pool without consuming model budget, and handles cancellation', async () => {
  const limits = new Limits({
    maxConcurrentAsk: 1,
    maxConcurrentIngest: 1,
    maxCallsPerMinute: 1,
  });
  const fetcher: Fetcher = () => Promise.resolve(fetched());
  const release = await limits.acquire('ask');
  const running = locateVersions('garden grants', history([url(0)]), {
    fetcher,
    limits,
  });
  await vi.waitFor(() => {
    expect(limits.pool('ask').queued).toBe(1);
  });
  release();
  expect((await running).status).toBe('ok');
  expect(limits.pool('ask').inFlight).toBe(0);
  const controller = new AbortController();
  controller.abort();
  await expect(
    locateVersions('garden grants', history([url(0)]), {
      fetcher,
      limits,
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
it('parses XML and HTML into plain text without a model', async () => {
  for (const [format, text] of [
    [
      'xml',
      '<bill><legis-body><section><enum>1</enum><text>Garden grants support schools.</text></section></legis-body></bill>',
    ],
    [
      'html',
      '<html><body><h2>Section 1. Grants</h2><p>Garden grants support schools.</p></body></html>',
    ],
  ] as const) {
    const fetcher: Fetcher = () =>
      Promise.resolve({ ...fetched(text), format });
    const result = await locateVersions('garden grants', history([url(0)]), {
      fetcher,
    });
    expect(result.versions[0]?.overlap).toBe(1);
    expect(result.versions[0]?.excerpt).not.toContain('<');
  }
});

it('uses only current wording of a marked version', async () => {
  const html =
    '<html><body><h2>Section 1. Fee</h2><p>The grantee pays a fee of <s>forty dollars</s> <u>fifty dollars</u> each month.</p></body></html>';
  const fetcher: Fetcher = () =>
    Promise.resolve({ ...fetched(html), format: 'html' as const });
  const result = await locateVersions(
    'pays forty dollars each month',
    history([url(0)]),
    { fetcher },
  );
  expect(result.versions[0]?.excerpt ?? '').not.toContain('forty');
});
it('returns the versions read before the time cap', async () => {
  // AbortSignal.timeout uses native timers, so hand the code a signal we can fire.
  const cap = new AbortController();
  vi.spyOn(AbortSignal, 'timeout').mockReturnValue(cap.signal);
  let calls = 0;
  const fetcher: Fetcher = () => {
    calls++;
    if (calls === 1) return Promise.resolve(fetched());
    cap.abort(new DOMException('cap', 'TimeoutError'));
    return Promise.reject(new Error('aborted'));
  };
  const result = await locateVersions(
    'garden grants',
    history([url(0), url(1), url(2)]),
    { fetcher },
  );
  vi.restoreAllMocks();
  expect(calls).toBe(2);
  expect(result.status).toBe('ok');
  expect(result.versions).toHaveLength(1);
});
