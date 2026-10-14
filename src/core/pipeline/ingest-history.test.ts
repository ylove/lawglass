import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import {
  BILLSTATUS_XML,
  makeBillStatusXml,
} from '../../../tests/synth/billstatus.js';
import { makeCongressionalBillXml } from '../../../tests/synth/index.js';
import { safeFetch } from '../fetch/index.js';
import * as historyStore from '../history/history-store.js';
import { Registry } from '../registry.js';
import { ingest, type IngestDeps, type Fetcher } from './ingest.js';
import { AppError } from '../model/index.js';

let dir: string;
let agent: MockAgent;
let deps: IngestDeps;
const page = 'https://www.congress.gov/bill/118th-congress/house-bill/9001';
const origin = 'https://www.govinfo.gov';
const statusPath = '/bulkdata/BILLSTATUS/118/hr/BILLSTATUS-118hr9001.xml';
const textPath = (version: string) =>
  `/content/pkg/BILLS-118hr9001${version}/xml/BILLS-118hr9001${version}.xml`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-history-'));
  agent = new MockAgent();
  agent.disableNetConnect();
  const now = () => new Date('2026-10-14T00:00:00.000Z');
  deps = {
    backend: new MemoryBackend(),
    provider: new ScriptedProvider(),
    registry: new Registry(dir, { now }),
    now,
    fetcher: vi.fn<Fetcher>((url, options) =>
      safeFetch(url, {
        ...options,
        cacheDir: join(dir, 'cache'),
        resolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
        dispatcherFactory: () => agent,
      }),
    ),
  };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await agent.close();
  await rm(dir, { recursive: true, force: true });
});

function serveStatus(xml = BILLSTATUS_XML) {
  agent
    .get(origin)
    .intercept({ path: statusPath })
    .reply(200, xml, { headers: { 'content-type': 'application/xml' } });
}
function serveText(version: string, bytes = makeCongressionalBillXml().bytes) {
  agent
    .get(origin)
    .intercept({ path: textPath(version) })
    .reply(200, Buffer.from(bytes), {
      headers: { 'content-type': 'application/xml' },
    });
}

test('a congress.gov landing page ingests the latest text with history through real safeFetch', async () => {
  serveStatus();
  serveText('eh');
  const result = await ingest(page, deps);
  expect(result.normalized.sourceUrl).toBe(`${origin}${textPath('eh')}`);
  expect(result.normalized.metadata.version).toBe('Engrossed in House (eh)');
  expect(
    result.normalized.metadata.sponsorProfiles?.map((item) => item.bioguideId),
  ).toEqual(['X000001', 'X000002']);
  expect((await deps.registry.getDocument(result.doc.docId)).metadata).toEqual(
    result.normalized.metadata,
  );
  expect(
    (await historyStore.readHistory(dir, result.doc.docId))?.officialSummary
      ?.source,
  ).toBe('Congressional Research Service');
  expect(
    vi.mocked(deps.fetcher).mock.calls.map(([url]) => new URL(url).hostname),
  ).toEqual(['www.govinfo.gov', 'www.govinfo.gov']);
  agent.assertNoPendingInterceptors();
});

test.each([
  `${page}/text/ih`,
  `${origin}${textPath('ih')}`,
  `${origin}/app/details/BILLS-118hr9001ih`,
])('URL version wins over newer history: %s', async (input) => {
  serveStatus();
  serveText('ih');
  const result = await ingest(input, deps);
  expect(result.normalized.metadata.version).toBe('Introduced in House (ih)');
  expect(result.normalized.sourceUrl).toBe(`${origin}${textPath('ih')}`);
  expect(
    (await historyStore.readHistory(dir, result.doc.docId))?.versions.map(
      (item) => item.code,
    ),
  ).toEqual(['ih', 'eh']);
  agent.assertNoPendingInterceptors();
});

test.each(['download', 'parse'])(
  'explicit text still ingests when history %s fails and exposes a UI warning',
  async (failure) => {
    if (failure === 'download')
      agent
        .get(origin)
        .intercept({ path: statusPath })
        .reply(503, 'unavailable');
    else serveStatus('<billStatus>broken');
    serveText('ih');
    const result = await ingest(`${page}/text/ih`, deps);
    expect(result.normalized.warnings.join(' ')).toMatch(/History unavailable/);
    expect(result.normalized.metadata.version).toBe('ih');
    expect(await deps.backend.hasDocument(result.doc.docId)).toBe(true);
    expect(
      (await deps.registry.getDocument(result.doc.docId)).warnings.join(' '),
    ).toMatch(/History unavailable/);
    expect(
      await historyStore.readHistory(dir, result.doc.docId),
    ).toBeUndefined();
    agent.assertNoPendingInterceptors();
  },
);

test.each(['download', 'parse', 'no versions'])(
  'versionless record failure (%s) asks for a specific version and does not guess',
  async (failure) => {
    if (failure === 'download')
      agent
        .get(origin)
        .intercept({ path: statusPath })
        .reply(503, 'unavailable');
    else
      serveStatus(
        failure === 'parse'
          ? '<broken/>'
          : BILLSTATUS_XML.replace(
              /<textVersions>[\s\S]*?<\/textVersions>/,
              '<textVersions/>',
            ),
      );
    const error: unknown = await ingest(page, deps).catch(
      (error: unknown) => error,
    );
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('FETCH_FAILED');
    expect((error as AppError).userMessage).toContain('specific version URL');
    expect(deps.fetcher).toHaveBeenCalledOnce();
    expect(await deps.registry.list()).toEqual([]);
  },
);

test.each([
  'https://www.congress.gov/help',
  'https://www.congress.gov./help',
  'https://api.congress.gov/help',
  `${page}/all-info`,
  `${page}/../9001`,
  'http://congress.gov/bill/118th-congress/house-bill/9001',
])('unmatched congress.gov URL makes zero requests: %s', async (input) => {
  await expect(ingest(input, deps)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(deps.fetcher).not.toHaveBeenCalled();
});

test('history redirects to congress.gov are blocked before a request to the destination', async () => {
  const congress = agent
    .get('https://www.congress.gov')
    .intercept({ path: '/help' })
    .reply(200, Buffer.from(makeBillStatusXml()));
  agent
    .get(origin)
    .intercept({ path: statusPath })
    .reply(302, '', { headers: { location: 'https://www.congress.gov/help' } });
  serveText('ih');
  const result = await ingest(`${page}/text/ih`, deps);
  expect(result.normalized.warnings.join(' ')).toMatch(/History unavailable/);
  expect(congress).toBeDefined();
  expect(agent.pendingInterceptors().map((item) => item.origin)).toEqual([
    'https://www.congress.gov',
  ]);
});

test('text redirects cannot leave the source allowlist', async () => {
  serveStatus();
  agent
    .get(origin)
    .intercept({ path: textPath('ih') })
    .reply(302, '', { headers: { location: 'https://www.congress.gov/help' } });
  await expect(ingest(`${page}/text/ih`, deps)).rejects.toMatchObject({
    code: 'SSRF_BLOCKED',
  });
  expect(await deps.registry.list()).toEqual([]);
});

test('ordinary document URLs cannot redirect into congress.gov either', async () => {
  agent
    .get('https://example.gov')
    .intercept({ path: '/bill' })
    .reply(302, '', { headers: { location: page } });
  await expect(ingest('https://example.gov/bill', deps)).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  expect(await deps.registry.list()).toEqual([]);
});

test('latest text selection refreshes a mutable BILLSTATUS record', async () => {
  serveStatus(
    BILLSTATUS_XML.replace(
      /<item><date>2024-06-10T00:00:00Z<\/date>[\s\S]*?<\/formats><\/item>/,
      '',
    ),
  );
  serveText('ih');
  const introduced = await ingest(page, deps);
  expect(introduced.normalized.metadata.version).toBe(
    'Introduced in House (ih)',
  );
  serveStatus();
  serveText(
    'eh',
    new TextEncoder().encode(
      `${new TextDecoder().decode(makeCongressionalBillXml().bytes)}\n<!-- Engrossed synthetic version -->`,
    ),
  );
  const engrossed = await ingest(page, deps);
  expect(engrossed.doc.docId).not.toBe(introduced.doc.docId);
  expect(engrossed.normalized.metadata.version).toBe('Engrossed in House (eh)');
  agent.assertNoPendingInterceptors();
});

test('a missing format in the latest version never silently selects an older version', async () => {
  serveStatus(
    BILLSTATUS_XML.replace(
      'https://www.govinfo.gov/content/pkg/BILLS-118hr9001eh/pdf/BILLS-118hr9001eh.pdf',
      'https://evil.test/bill',
    ),
  );
  const error: unknown = await ingest(page, deps).catch(
    (error: unknown) => error,
  );
  expect(error).toBeInstanceOf(AppError);
  expect((error as AppError).userMessage).toContain('specific version URL');
  expect(deps.fetcher).toHaveBeenCalledOnce();
});

test('failed registration cleans up its sidecar and half-indexed namespace', async () => {
  serveStatus();
  serveText('ih');
  vi.spyOn(deps.registry, 'add').mockRejectedValue(new Error('disk full'));
  await expect(ingest(`${page}/text/ih`, deps)).rejects.toThrow();
  const docId = (
    await safeFetch(`${origin}${textPath('ih')}`, {
      cacheDir: join(dir, 'cache'),
      resolver: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
      dispatcherFactory: () => agent,
    })
  ).docId;
  expect(await deps.backend.hasDocument(docId)).toBe(false);
  expect(await historyStore.readHistory(dir, docId)).toBeUndefined();
});

test('history persistence failure after text was read never blocks indexing', async () => {
  serveStatus();
  serveText('ih');
  vi.spyOn(historyStore, 'writeHistory').mockRejectedValue(
    new Error('private filesystem detail'),
  );
  const result = await ingest(`${page}/text/ih`, deps);
  expect(result.normalized.warnings.join(' ')).toMatch(/History unavailable/);
  expect(result.normalized.warnings.join(' ')).not.toContain(
    'private filesystem detail',
  );
  expect(await deps.backend.hasDocument(result.doc.docId)).toBe(true);
});

test('reuse refreshes history and spends no tokens; removal deletes the sidecar', async () => {
  serveStatus();
  serveText('ih');
  const first = await ingest(`${page}/text/ih`, deps);
  const provider = vi.spyOn(deps.provider, 'generateObject');
  const upsert = vi.spyOn(deps.backend, 'upsertChunks');
  serveStatus();
  const again = await ingest(`${page}/text/ih`, deps);
  expect(again.stats.reused).toBe(true);
  expect(again.usage).toEqual({
    embedTokens: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  });
  expect(provider).not.toHaveBeenCalled();
  expect(upsert).not.toHaveBeenCalled();
  await deps.backend.deleteDocument(first.doc.docId);
  await deps.registry.remove(first.doc.docId);
  expect(await historyStore.readHistory(dir, first.doc.docId)).toBeUndefined();
});

test('eviction deletes history alongside the cached document and namespace', async () => {
  serveStatus();
  serveText('ih');
  const first = await ingest(`${page}/text/ih`, { ...deps, maxDocs: 1 });
  agent
    .get('https://example.gov')
    .intercept({ path: '/other.txt' })
    .reply(200, 'Section 1. Another bill\nAnother document.');
  await ingest('https://example.gov/other.txt', { ...deps, maxDocs: 1 });
  expect(await deps.backend.hasDocument(first.doc.docId)).toBe(false);
  expect(await historyStore.readHistory(dir, first.doc.docId)).toBeUndefined();
});

test('an aborted history read is propagated instead of ingesting text', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    ingest(`${page}/text/ih`, deps, { signal: controller.signal }),
  ).rejects.toThrow();
  expect(deps.fetcher).toHaveBeenCalledOnce();
});
