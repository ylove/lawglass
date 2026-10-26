import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockAgent } from 'undici';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { AppError } from '../core/model/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { safeFetch } from '../core/fetch/index.js';
import { writeCache } from '../core/fetch/cache.js';
import { createApp, type AppOptions } from './app.js';
import { privateCookieValue, SESSION_COOKIE } from './session.js';

const accessKey = 'k'.repeat(40);
const cookie = `${SESSION_COOKIE}=${privateCookieValue(accessKey)}`;
const sourceUrl = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
let root: string;
let agent: MockAgent | undefined;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(sourceUrl, makeSectionedText(), 'text/plain');
  root = await mkdtemp(join(tmpdir(), 'private-web-'));
  await mkdir(join(root, 'assets'));
  await writeFile(join(root, 'index.html'), '<div id="root">SPA</div>');
  await writeFile(join(root, 'assets/app.js'), 'SECRET SPA BUNDLE');
  await writeFile(join(root, 'gate.css'), 'main { color: navy; }');
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await agent?.close();
  agent = undefined;
  await env.cleanup();
  await rm(root, { recursive: true, force: true });
});
const app = (options: AppOptions = {}) =>
  createApp(env.runtime, {
    privateMode: true,
    accessKey,
    webRoot: root,
    logWriter: () => undefined,
    ...options,
  });
const post = (url = sourceUrl, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ url }),
});

test('gate and only brand assets are accessible without a session; the full app works with an invite', async () => {
  const a = app({ publicOrigin: 'https://preview.example' });
  const gate = await a.request('http://preview.example/');
  expect(gate.status).toBe(200);
  const html = await gate.text();
  expect(html).toContain('og:title');
  expect(html).toContain('https://preview.example/');
  expect(html).not.toMatch(/og:image|<img|apple-touch-icon/);
  expect(html).not.toContain('SPA');
  expect((await a.request('/api/docs')).status).toBe(401);
  expect(await (await a.request('/assets/app.js')).text()).not.toContain(
    'SECRET SPA BUNDLE',
  );
  expect((await a.request('/gate.css')).headers.get('content-type')).toContain(
    'text/css',
  );
  expect((await a.request('/favicon.svg')).status).toBe(404);
  const exchange = await a.request(`http://preview.example/?k=${accessKey}`);
  expect(exchange.headers.get('location')).toBe('/');
  expect(exchange.headers.get('set-cookie')).toContain(
    privateCookieValue(accessKey),
  );
  const config = await a.request('http://preview.example/api/config', {
    headers: { cookie, origin: 'https://preview.example' },
  });
  expect(await config.json()).toMatchObject({
    publicMode: false,
    freeformEnabled: true,
    scenariosEnabled: true,
  });
  expect(
    await (await a.request('/', { headers: { cookie } })).text(),
  ).toContain('SPA');
  const ingest = await a.request('/api/ingest', post());
  const body = await ingest.text();
  expect(body).toContain('"type":"done"');
  const [entry] = await env.registry.list();
  const answer = await a.request(`/api/docs/${entry!.docId}/ask`, {
    ...post(),
    body: JSON.stringify({ question: 'Who must file a report?' }),
  });
  expect(await answer.text()).toContain('"type":"done"');
});

test('keeps Origin, cross-site, content-type and body-size guards', async () => {
  const a = app();
  for (const [headers, status] of [
    [{ origin: 'https://evil.example' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
    [{ 'content-type': 'text/plain' }, 415],
  ] as const)
    expect(
      (await a.request('/api/ingest', post(sourceUrl, headers))).status,
    ).toBe(status);
  expect(
    (await a.request('/api/ingest', { ...post(), body: 'x'.repeat(17000) }))
      .status,
  ).toBe(413);
  expect(env.fetches).toEqual([]);
});

test.each([true, false])(
  'host policy runs before any fetch in private=%s',
  async (privateMode) => {
    const a = app({ privateMode, publicMode: !privateMode });
    for (const host of [
      'pub.njleg.gov',
      'www.palegis.us',
      '127.0.0.1',
      'evil.govinfo.gov',
      'govinfo.gov@evil.example',
    ]) {
      const response = await a.request(
        '/api/ingest',
        post(`https://${host}/bill`),
      );
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        'Other states are on the roadmap.',
      );
    }
    expect(env.fetches).toEqual([]);
  },
);

test('environment host override is applied at app construction', async () => {
  vi.stubEnv(
    (await import('../core/brand.js')).envVar('INGEST_HOSTS'),
    'example.gov',
  );
  env.serve('https://example.gov/a.txt', makeSectionedText(), 'text/plain');
  const a = app();
  expect((await a.request('/api/ingest', post())).status).toBe(400);
  expect(
    await (
      await a.request('/api/ingest', post('https://example.gov/a.txt'))
    ).text(),
  ).toContain('"type":"done"');
});

function useSafeFetch() {
  const mock = new MockAgent();
  mock.disableNetConnect();
  agent = mock;
  const resolver = vi.fn(() =>
    Promise.resolve([{ address: '8.8.8.8', family: 4 as const }]),
  );
  const dispatcherFactory = vi.fn(() => mock);
  const cacheDir = join(env.dir, 'fetch-cache');
  env.runtime.fetcher = (url, options) =>
    safeFetch(url, { ...options, resolver, dispatcherFactory, cacheDir });
  return { mock, resolver, dispatcherFactory, cacheDir };
}

test.each([true, false])(
  'hosted redirects reject an outside host before DNS or transport in private=%s',
  async (privateMode) => {
    const { mock, resolver, dispatcherFactory } = useSafeFetch();
    mock
      .get('https://govinfo.gov')
      .intercept({ path: '/a.txt' })
      .reply(302, '', {
        headers: { location: 'https://www.govinfo.gov/b.txt' },
      });
    mock
      .get('https://www.govinfo.gov')
      .intercept({ path: '/b.txt' })
      .reply(302, '', {
        headers: { location: 'https://outside.example/c.txt' },
      });
    const response = await app({
      privateMode,
      publicMode: !privateMode,
    }).request('/api/ingest', post());
    const body = await response.text();
    expect(body).toContain('Other states are on the roadmap.');
    expect(body).not.toContain('"type":"done"');
    expect(resolver.mock.calls).toEqual([['govinfo.gov'], ['www.govinfo.gov']]);
    expect(dispatcherFactory).toHaveBeenCalledTimes(2);
    mock.assertNoPendingInterceptors();
  },
);

test.each([true, false])(
  'hosted redirects and their cached final URL allow official hosts in private=%s',
  async (privateMode) => {
    const { mock, dispatcherFactory } = useSafeFetch();
    mock
      .get('https://govinfo.gov')
      .intercept({ path: '/a.txt' })
      .reply(302, '', {
        headers: { location: 'https://www.govinfo.gov/b.txt' },
      });
    mock
      .get('https://www.govinfo.gov')
      .intercept({ path: '/b.txt' })
      .reply(200, Buffer.from(makeSectionedText().bytes), {
        headers: { 'content-type': 'text/plain' },
      });
    const a = app({ privateMode, publicMode: !privateMode });
    for (let i = 0; i < 2; i++)
      expect(await (await a.request('/api/ingest', post())).text()).toContain(
        '"type":"done"',
      );
    expect(dispatcherFactory).toHaveBeenCalledTimes(2);
    mock.assertNoPendingInterceptors();
  },
);

test.each([true, false])(
  'hosted ingest rejects an outside cached final URL in private=%s',
  async (privateMode) => {
    const { cacheDir, resolver, dispatcherFactory } = useSafeFetch();
    await writeCache(
      makeSectionedText().bytes,
      {
        url: sourceUrl,
        finalUrl: 'https://outside.example/b.txt',
        contentType: 'text/plain',
        fetchedAt: new Date().toISOString(),
      },
      cacheDir,
    );
    const response = await app({
      privateMode,
      publicMode: !privateMode,
    }).request('/api/ingest', post());
    expect(await response.text()).toContain('Other states are on the roadmap.');
    expect(resolver.mock.calls).toEqual([['govinfo.gov']]);
    expect(dispatcherFactory).not.toHaveBeenCalled();
  },
);

test.each([true, false])(
  'hosted ingest aborts at its overall deadline in private=%s and releases its slot',
  async (privateMode) => {
    let signal: AbortSignal | undefined;
    let ready: () => void = () => undefined;
    const fetching = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const original = env.runtime.fetcher;
    env.runtime.fetcher = (_url, options) => {
      signal = options?.signal;
      ready();
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            reject(new Error('Aborted'));
          },
          { once: true },
        );
      });
    };
    vi.useFakeTimers();
    const lines: string[] = [];
    const duration = privateMode ? 15 * 60 * 1000 : 1000;
    const a = app({
      privateMode,
      publicMode: !privateMode,
      ...(privateMode ? {} : { ingestDeadlineMs: duration }),
      heartbeatMs: 1_000_000,
      limits: { maxDocs: 1 },
      logWriter: (line) => {
        lines.push(line);
      },
    });
    const response = await a.request('/api/ingest', post());
    const body = response.text();
    await fetching;
    await vi.advanceTimersByTimeAsync(duration - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    expect(await body).toContain(
      'This bill took too long to process. Try a link to a specific version, or try again later.',
    );
    expect(await body).toContain('TOO_LARGE');
    expect(lines.join('')).not.toContain(sourceUrl);
    expect(lines.join('')).toContain('ingest_finish');
    vi.useRealTimers();
    env.runtime.fetcher = original;
    expect(await (await a.request('/api/ingest', post())).text()).toContain(
      '"type":"done"',
    );
  },
);

test('local ingest has no hosted deadline', async () => {
  const local = createApp(env.runtime, {
    sessionToken: accessKey,
    ingestDeadlineMs: 0,
    logWriter: () => undefined,
  });
  const response = await local.request(
    '/api/ingest',
    post(sourceUrl, { cookie: `${SESSION_COOKIE}=${accessKey}` }),
  );
  expect(await response.text()).toContain('"type":"done"');
});

test('invalid mode, key and hop options fail before serving', () => {
  for (const options of [
    { publicMode: true },
    { accessKey: 'short' },
    { trustProxyHops: -1 },
    { trustProxyHops: 0.5 },
  ])
    expect(() => app(options)).toThrow();
});

test('a failed metadata call is logged with its code, never the address or a message (#270)', async () => {
  vi.spyOn(env.runtime.extractProvider, 'generateObject').mockRejectedValue(
    new AppError('PROVIDER_ERROR', 'upstream said something private'),
  );
  const lines: string[] = [];
  const a = app({
    privateMode: true,
    logWriter: (line) => {
      lines.push(line);
    },
  });
  expect(await (await a.request('/api/ingest', post())).text()).toContain(
    '"type":"done"',
  );
  const failed = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((entry) => entry.event === 'metadata_failed');
  expect(failed).toMatchObject({ level: 'warn', code: 'PROVIDER_ERROR' });
  expect(lines.join('')).not.toContain(sourceUrl);
  expect(lines.join('')).not.toContain('upstream said something private');
});
