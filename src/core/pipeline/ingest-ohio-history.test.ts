import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { makeOhioHistoryPages } from '../../../tests/synth/ohio-history.js';
import { makeCongressionalBillXml } from '../../../tests/synth/index.js';
import { safeFetch } from '../fetch/index.js';
import { BRAND } from '../brand.js';
import { readHistory } from '../history/history-store.js';
import { Registry } from '../registry.js';
import { ingest, type IngestDeps, type Fetcher } from './ingest.js';

const origin = 'https://www.legislature.ohio.gov';
const landing = `${origin}/legislation/135/hb9001`;
const textOrigin = 'https://search-prod.lis.state.oh.us';
const textPath = (version: string) =>
  `/api/v2/general_assembly_135/legislation/hb9001/${version}/pdf/`;
const ua = `${BRAND.name}/${BRAND.version} (+${BRAND.repositoryUrl})`;
let dir: string;
let agent: MockAgent;
let deps: IngestDeps;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ingest-ohio-'));
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
  await agent.close();
  await rm(dir, { recursive: true, force: true });
});
function servePages(
  options: {
    failure?: 'status' | 'documents' | 'committee';
    parseFailure?: boolean;
    redirect?: string;
  } = {},
) {
  const pages = makeOhioHistoryPages();
  for (const kind of ['status', 'documents', 'committee'] as const) {
    const request = agent.get(origin).intercept({
      path: `/legislation/135/hb9001/${kind}`,
      headers: { 'user-agent': ua },
    });
    if (options.failure === kind) {
      if (options.redirect)
        request.reply(302, '', { headers: { location: options.redirect } });
      else
        request.reply(
          options.parseFailure ? 200 : 503,
          options.parseFailure ? '<html>Blocked</html>' : 'Unavailable',
        );
      // Transport failures stop before the remaining pages are read.
      if (!options.parseFailure) break;
    } else
      request.reply(200, pages[kind], {
        headers: { 'content-type': 'text/html' },
      });
  }
}
function serveText(version: string) {
  agent
    .get(textOrigin)
    .intercept({ path: textPath(version), headers: { 'user-agent': ua } })
    .reply(200, Buffer.from(makeCongressionalBillXml().bytes), {
      headers: { 'content-type': 'application/xml' },
    });
}
test.each(['', '/status', '/documents', '/committee'])(
  'Ohio landing URL %s selects latest text, stores history and official sponsor links',
  async (suffix) => {
    servePages();
    serveText('06_EN');
    const result = await ingest(`${landing}${suffix}`, deps);
    expect(result.normalized.sourceUrl).toBe(
      `${textOrigin}${textPath('06_EN')}`,
    );
    expect(result.normalized.metadata.version).toBe('As Enrolled (06_EN)');
    expect(result.normalized.metadata.sponsorProfiles?.[0]).toMatchObject({
      memberId: 'alex-example',
      links: [{ kind: 'legislature', verified: true }],
    });
    expect((await readHistory(dir, result.doc.docId))?.versions).toHaveLength(
      7,
    );
    expect(result.normalized.warnings.join(' ')).not.toContain(
      'History unavailable',
    );
    expect(vi.mocked(deps.fetcher).mock.calls.map(([url]) => url)).toEqual(
      ['status', 'documents', 'committee']
        .map((kind) => `${landing}/${kind}`)
        .concat(`${textOrigin}${textPath('06_EN')}`),
    );
    agent.assertNoPendingInterceptors();
  },
);
test('explicit LIS version wins over newer listed versions', async () => {
  servePages();
  serveText('00_IN');
  const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
  expect(result.normalized.metadata.version).toBe('As Introduced (00_IN)');
  expect((await readHistory(dir, result.doc.docId))?.versions[0]!.code).toBe(
    '06_EN',
  );
  agent.assertNoPendingInterceptors();
});
test.each(['status', 'documents', 'committee'] as const)(
  'any %s download failure preserves explicit text ingest with history unavailable',
  async (failure) => {
    servePages({ failure });
    serveText('00_IN');
    const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
    expect(result.normalized.warnings.join(' ')).toContain(
      'History unavailable',
    );
    expect(result.normalized.metadata.sponsorProfiles).toBeUndefined();
    expect(await readHistory(dir, result.doc.docId)).toBeUndefined();
    expect(await deps.backend.hasDocument(result.doc.docId)).toBe(true);
    agent.assertNoPendingInterceptors();
  },
);
test.each(['status', 'documents', 'committee'] as const)(
  'any %s parse failure also discards the complete history attachment',
  async (failure) => {
    servePages({ failure, parseFailure: true });
    serveText('00_IN');
    const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
    expect(result.normalized.warnings.join(' ')).toContain(
      'History unavailable',
    );
    expect(await readHistory(dir, result.doc.docId)).toBeUndefined();
    agent.assertNoPendingInterceptors();
  },
);
test('versionless landing fails clearly when history is unavailable', async () => {
  servePages({ failure: 'documents' });
  await expect(ingest(landing, deps)).rejects.toMatchObject({
    code: 'FETCH_FAILED',
    userMessage: expect.stringContaining('specific version URL') as unknown,
  });
  expect(await deps.registry.list()).toEqual([]);
  expect(deps.fetcher).toHaveBeenCalledTimes(2);
  agent.assertNoPendingInterceptors();
});
test.each([
  'https://ohiohouse.gov/members/alex-example',
  'https://www.legislature.ohio.gov.evil.test/status',
  'http://www.legislature.ohio.gov/status',
])('blocks history redirect %s before transport', async (redirect) => {
  servePages({ failure: 'status', redirect });
  serveText('00_IN');
  const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
  expect(result.normalized.warnings.join(' ')).toContain('History unavailable');
  agent.assertNoPendingInterceptors();
});
test('text redirect to a member host fails instead of fetching the member', async () => {
  servePages();
  agent
    .get(textOrigin)
    .intercept({ path: textPath('00_IN') })
    .reply(302, '', {
      headers: { location: 'https://ohiosenate.gov/members/sam-sample' },
    });
  await expect(
    ingest(`${textOrigin}${textPath('00_IN')}`, deps),
  ).rejects.toMatchObject({ code: 'SSRF_BLOCKED' });
  expect(await deps.registry.list()).toEqual([]);
  agent.assertNoPendingInterceptors();
});
