import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { ScriptedProvider } from '../../../tests/contracts/scripted-provider.js';
import { makeOhioHistoryJson } from '../../../tests/synth/ohio-history.js';
import { makeCongressionalBillXml } from '../../../tests/synth/index.js';
import { safeFetch } from '../fetch/index.js';
import { BRAND } from '../brand.js';
import { readHistory } from '../history/history-store.js';
import { Registry } from '../registry.js';
import { ingest, type IngestDeps, type Fetcher } from './ingest.js';

const landing = 'https://www.legislature.ohio.gov/legislation/135/hb9001';
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
const ENDPOINTS = ['', 'actions/', 'meetings/', 'amendments/'] as const;
const apiPath = (endpoint: string) =>
  `/api/v2/general_assembly_135/legislation/hb9001/${endpoint}`;
function servePages(
  options: {
    failure?: (typeof ENDPOINTS)[number];
    parseFailure?: boolean;
    redirect?: string;
  } = {},
) {
  const json = makeOhioHistoryJson();
  const bodies = [json.versions, json.actions, json.meetings, json.amendments];
  for (const [index, endpoint] of ENDPOINTS.entries()) {
    const request = agent.get(textOrigin).intercept({
      path: apiPath(endpoint),
      headers: { 'user-agent': ua },
    });
    if (options.failure === endpoint) {
      if (options.redirect)
        request.reply(302, '', { headers: { location: options.redirect } });
      else
        request.reply(
          options.parseFailure ? 200 : 503,
          options.parseFailure ? '{"blocked":true}' : 'Unavailable',
          { headers: { 'content-type': 'application/json' } },
        );
      // Transport failures stop before the remaining endpoints are read.
      if (!options.parseFailure) break;
    } else
      request.reply(200, bodies[index], {
        headers: { 'content-type': 'application/json' },
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
  'Ohio landing URL %s selects latest text via the LIS API and stores history and sponsors',
  async (suffix) => {
    servePages();
    serveText('06_EN');
    const result = await ingest(`${landing}${suffix}`, deps);
    expect(result.normalized.sourceUrl).toBe(
      `${textOrigin}${textPath('06_EN')}`,
    );
    expect(result.normalized.metadata.version).toBe('As Enrolled (06_EN)');
    expect(result.normalized.metadata.sponsorProfiles?.[0]).toMatchObject({
      memberId: '1001',
      party: 'Republican',
    });
    // Ohio gives no member page, so the only links are labeled searches, never "verified".
    const links = result.normalized.metadata.sponsorProfiles?.[0]?.links ?? [];
    expect(links.length).toBeGreaterThan(0);
    expect(
      links.every((link) => link.kind === 'search' && !link.verified),
    ).toBe(true);
    expect((await readHistory(dir, result.doc.docId))?.versions).toHaveLength(
      7,
    );
    expect(result.normalized.warnings.join(' ')).not.toContain(
      'History unavailable',
    );
    expect(vi.mocked(deps.fetcher).mock.calls.map(([url]) => url)).toEqual(
      ENDPOINTS.map((endpoint) => `${textOrigin}${apiPath(endpoint)}`).concat(
        `${textOrigin}${textPath('06_EN')}`,
      ),
    );
    agent.assertNoPendingInterceptors();
  },
);
test('explicit LIS version wins over newer listed versions', async () => {
  servePages();
  serveText('00_IN');
  const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
  expect(result.normalized.metadata.version).toBe('As Introduced (00_IN)');
  expect(
    (await readHistory(dir, result.doc.docId))?.versions.at(-1)!.code,
  ).toBe('06_EN');
  agent.assertNoPendingInterceptors();
});
test.each(['', ...ENDPOINTS.slice(1)])(
  'a %j download failure: only the bill endpoint is required',
  async (failure) => {
    servePages({ failure: failure as (typeof ENDPOINTS)[number] });
    serveText('00_IN');
    const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
    const warnings = result.normalized.warnings.join(' ');
    expect(await deps.backend.hasDocument(result.doc.docId)).toBe(true);
    if (failure === '') {
      expect(warnings).toContain('History unavailable');
      // No official record: any profiles come from metadata names and are search-only.
      for (const profile of result.normalized.metadata.sponsorProfiles ?? []) {
        expect(profile.bioguideId ?? profile.memberId).toBeUndefined();
        expect(profile.links.every((link) => link.kind === 'search')).toBe(
          true,
        );
      }
      expect(await readHistory(dir, result.doc.docId)).toBeUndefined();
    } else {
      expect(warnings).toContain(
        'Part of the legislative history was unavailable',
      );
      expect(warnings).not.toContain('History unavailable');
      expect((await readHistory(dir, result.doc.docId))?.versions).toHaveLength(
        7,
      );
      expect(result.normalized.metadata.sponsorProfiles).toHaveLength(4);
    }
    agent.assertNoPendingInterceptors();
  },
);
test.each(ENDPOINTS.slice(1))(
  'a malformed %j response also only makes the history partial',
  async (failure) => {
    servePages({ failure, parseFailure: true });
    serveText('00_IN');
    const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
    expect(result.normalized.warnings.join(' ')).toContain(
      'Part of the legislative history was unavailable',
    );
    agent.assertNoPendingInterceptors();
  },
);
test('a malformed bill response discards the history attachment', async () => {
  servePages({ failure: '', parseFailure: true });
  serveText('00_IN');
  const result = await ingest(`${textOrigin}${textPath('00_IN')}`, deps);
  expect(result.normalized.warnings.join(' ')).toContain('History unavailable');
  expect(await readHistory(dir, result.doc.docId)).toBeUndefined();
  agent.assertNoPendingInterceptors();
});
test('versionless landing ingests the latest version when only optional parts fail', async () => {
  servePages({ failure: 'actions/' });
  serveText('06_EN');
  const result = await ingest(landing, deps);
  expect(result.normalized.metadata.version).toBe('As Enrolled (06_EN)');
  expect(result.normalized.warnings.join(' ')).toContain(
    'Part of the legislative history was unavailable',
  );
  agent.assertNoPendingInterceptors();
});
test('versionless landing fails clearly when the bill endpoint is unavailable', async () => {
  servePages({ failure: '' });
  await expect(ingest(landing, deps)).rejects.toMatchObject({
    code: 'FETCH_FAILED',
    userMessage: expect.stringContaining('specific version URL') as unknown,
  });
  expect(await deps.registry.list()).toEqual([]);
  expect(deps.fetcher).toHaveBeenCalledTimes(1);
  agent.assertNoPendingInterceptors();
});
test('an unmapped legislature URL is rejected before any fetch', async () => {
  await expect(
    ingest('https://www.legislature.ohio.gov./legislation/135/hb9001', deps),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(deps.fetcher).not.toHaveBeenCalled();
});
test.each([
  'https://ohiohouse.gov/members/alex-example',
  'https://www.legislature.ohio.gov.evil.test/status',
  'http://www.legislature.ohio.gov/status',
  'https://www.legislature.ohio.gov/legislation/135/hb9001/status',
])('blocks history redirect %s before transport', async (redirect) => {
  servePages({ failure: '', redirect });
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
