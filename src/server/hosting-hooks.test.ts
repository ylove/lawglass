import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context, Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeSectionedText } from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { ClientConfig, IngestEvent } from '../core/model/index.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';
import {
  contentSecurityPolicy,
  type CspExtensions,
} from './security-headers.js';
import { READER_COOKIE, readerKey } from './readers.js';

let env: PipelineEnv;
let root: string;
const url = 'https://govinfo.gov/a.txt';
const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Host sign-in required', 401),
  readerId: (c) => c.req.header('x-reader')!,
};
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(url, makeSectionedText(), 'text/plain');
  root = join(env.dir, 'web');
  await mkdir(root);
  await writeFile(
    join(root, 'index.html'),
    '<!doctype html><html><head><title>App</title></head><body>SPA</body></html>',
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    webRoot: root,
    logWriter: () => undefined,
    ...options,
  });
const request = (
  a: Hono,
  path: string,
  reader = 'account:alice',
  init: RequestInit = {},
) => {
  const headers = new Headers({
    'x-reader': reader,
    'content-type': 'application/json',
  });
  new Headers(init.headers).forEach((value, name) => {
    headers.set(name, value);
  });
  return a.request(path, {
    ...init,
    headers,
  });
};
async function ingest(a: Hono, reader = 'account:alice', source = url) {
  const res = await request(a, '/api/ingest', reader, {
    method: 'POST',
    body: JSON.stringify({ url: source }),
  });
  const events = [];
  for await (const event of readSseEvents(res, IngestEvent)) events.push(event);
  const done = events.at(-1);
  if (done?.type !== 'done') throw new Error(JSON.stringify(done));
  return done.doc;
}

describe('external auth', () => {
  test.each([null, {}, { middleware: 'invalid', readerId: () => 'reader' }])(
    'rejects malformed auth at app creation (%j)',
    (invalid) => {
      expect(() => app({ auth: invalid as unknown as ExternalAuth })).toThrow(
        'External auth requires',
      );
    },
  );

  test.each(['privateMode', 'publicMode'] as const)(
    'refuses combining auth with %s',
    (mode) => {
      expect(() => app({ [mode]: true })).toThrow(
        'External auth cannot be combined',
      );
    },
  );

  test('replaces shared-key auth on API and pages and enables hosted features without an access key', async () => {
    const a = app();
    for (const path of ['/', '/doc/a', '/api/config', '/api/docs']) {
      const res = await a.request(path);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe('Host sign-in required');
      expect(res.headers.get('set-cookie')).toBeNull();
      expect(res.headers.get('strict-transport-security')).toBe(
        'max-age=31536000',
      );
    }
    const res = await request(a, 'https://host.example/api/config');
    expect(res.status).toBe(200); // Non-loopback Host accepted by default.
    expect(ClientConfig.parse(await res.json())).toMatchObject({
      publicMode: false,
      freeformEnabled: true,
      library: 'reader',
      scenariosEnabled: true,
      breakdownEnabled: true,
      locateEnabled: true,
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await (await request(a, '/')).text()).toContain('SPA');
    expect(
      (
        await app({ localOnly: true }).request(
          'https://host.example/api/health',
        )
      ).status,
    ).toBe(403);
  });

  test('health and quickstart bypass auth, and health never creates a reader or cookie', async () => {
    const middleware = vi.fn(auth.middleware);
    const readerId = vi.fn(auth.readerId);
    const a = app({ auth: { middleware, readerId } });
    for (const method of ['GET', 'HEAD']) {
      const res = await a.request('/api/health', { method });
      expect(res.status).toBe(200);
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect((await a.request('/quickstart?k=irrelevant')).status).toBe(200);
    expect(middleware).not.toHaveBeenCalled();
    expect(readerId).not.toHaveBeenCalled();
    await expect(
      readdir(join(env.registry.configDir, 'readers')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('request safety checks precede host auth; auth precedes the body limit', async () => {
    const middleware = vi.fn(auth.middleware);
    const a = app({ auth: { ...auth, middleware } });
    const unsafeHeaders: Record<string, string>[] = [
      { origin: 'https://evil.example' },
      { 'sec-fetch-site': 'cross-site' },
      { 'content-type': 'text/plain' },
    ];
    for (const headers of unsafeHeaders) {
      const res = await a.request('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      });
      expect([403, 415]).toContain(res.status);
    }
    expect(middleware).not.toHaveBeenCalled();
    const res = await a.request('/api/ingest', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'x'.repeat(20_000),
    });
    expect(res.status).toBe(401);
  });

  test('opaque reader ids key separate lists, ignore cookies, and never reach filenames or logs', async () => {
    const logWriter = vi.fn();
    const a = app({ logWriter });
    const alice = 'account:alice';
    const bob = '../../account:bob'; // Even trusted identities are hashed before touching disk.
    const doc = await ingest(a, alice);
    expect(await (await request(a, '/api/docs', bob)).json()).toEqual([]);
    expect(await (await request(a, '/api/docs', alice)).json()).toMatchObject([
      { docId: doc.docId },
    ]);
    const opened = await request(a, `/api/docs/${doc.docId}`, bob, {
      headers: { cookie: `${READER_COOKIE}=aaaaaaaaaaaaaaaaaaaaaa` },
    });
    expect(opened.status).toBe(200);
    expect(opened.headers.get('set-cookie')).toBeNull();
    expect(await (await request(a, '/api/docs', bob)).json()).toMatchObject([
      { docId: doc.docId },
    ]);
    expect(
      (await request(a, `/api/docs/${doc.docId}`, alice, { method: 'DELETE' }))
        .status,
    ).toBe(204);
    expect(await (await request(a, '/api/docs', alice)).json()).toEqual([]);
    expect(await (await request(a, '/api/docs', bob)).json()).toHaveLength(1);
    expect(
      (await readdir(join(env.registry.configDir, 'readers'))).sort(),
    ).toEqual([`${readerKey(alice)}.json`, `${readerKey(bob)}.json`].sort());
    expect(JSON.stringify(logWriter.mock.calls)).not.toContain(alice);
    expect(JSON.stringify(logWriter.mock.calls)).not.toContain(bob);
  });

  test('missing external identity fails without issuing a cookie or listing documents', async () => {
    const list = vi.spyOn(env.registry, 'list');
    const a = app({ auth: { ...auth, readerId: () => '' } });
    const res = await request(a, '/api/docs');
    expect(res.status).toBe(500);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(list).not.toHaveBeenCalled();
  });

  test('authenticated ingest SSE responses set no reader or session cookie', async () => {
    const res = await request(app(), '/api/ingest', 'account:alice', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('"type":"done"');
  });
});

describe('document read access', () => {
  test('every registered document route refuses before storage, providers, body parsing or reader setup', async () => {
    const missing = await request(app(), '/api/docs/missing');
    const missingBody: unknown = await missing.json();
    const canRead = vi.fn(() => Promise.resolve(false));
    const readerId = vi.fn(auth.readerId);
    const a = app({ canRead, auth: { ...auth, readerId } });
    const list = vi
      .spyOn(env.registry, 'list')
      .mockRejectedValue(new Error('Must not read registry'));
    const routes = a.routes.filter((route) =>
      route.path.startsWith('/api/docs/:docId'),
    );
    expect(routes.length).toBeGreaterThanOrEqual(10);
    for (const route of routes) {
      const path = route.path
        .replace(/:docId\b/g, 'denied')
        .replace(/:[A-Za-z]+/g, 'section-1')
        .replace('*', 'future-route');
      // Include ALL registrations too: Hono uses them for middleware, and a future handler may
      // use app.all(). Testing the wildcard itself also covers an as-yet unregistered subroute.
      const methods =
        route.method === 'ALL'
          ? ['GET', 'HEAD', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS']
          : route.method === 'GET'
            ? ['GET', 'HEAD']
            : [route.method];
      for (const method of methods) {
        canRead.mockClear();
        const res = await request(a, path, 'account:alice', {
          method,
          ...(method === 'POST' ? { body: 'x'.repeat(20_000) } : {}),
        });
        expect(res.status, `${method} ${route.path}`).toBe(404);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('set-cookie')).toBeNull();
        if (method !== 'HEAD') expect(await res.json()).toEqual(missingBody);
        expect(canRead).toHaveBeenCalledExactlyOnceWith(
          expect.anything(),
          'denied',
        );
      }
    }
    expect(readerId).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(env.fetches).toEqual([]);
  });

  test.each([true, Promise.resolve(true)])(
    'allows permitted reads and calls the hook once',
    async (allowed) => {
      const canRead = vi.fn(() => allowed);
      const a = app({ canRead });
      const doc = await ingest(a);
      expect((await request(a, `/api/docs/${doc.docId}`)).status).toBe(200);
      expect(canRead).toHaveBeenCalledOnce();
    },
  );

  test('hook failures fail closed', async () => {
    const list = vi.spyOn(env.registry, 'list');
    const a = app({
      canRead: () => {
        throw new Error('Host lookup failed');
      },
    });
    expect((await request(a, '/api/docs/denied')).status).toBe(500);
    expect(list).not.toHaveBeenCalled();
  });

  test('rechecks access when a Request object is dispatched again', async () => {
    const canRead = vi.fn(() => true);
    const a = app({ canRead });
    const doc = await ingest(a);
    const raw = new Request(`http://localhost/api/docs/${doc.docId}`, {
      headers: { 'x-reader': 'account:alice' },
    });
    expect((await a.request(raw)).status).toBe(200);
    canRead.mockReturnValue(false);
    expect((await a.request(raw)).status).toBe(404);
    expect(canRead).toHaveBeenCalledTimes(2);
  });
});

describe('presentation options', () => {
  test('rejects non-function hooks at app creation', () => {
    for (const options of [
      { canRead: false },
      { pinned: true },
      { site: { landing: 'html' } },
      { site: { quickstart: 'html' } },
    ]) {
      expect(() => app(options as unknown as AppOptions)).toThrow(
        'must be a function',
      );
    }
  });

  test('CSP extensions append to defaults, including new frame sources', async () => {
    const csp: CspExtensions = {
      'script-src': ['https://cdn.example:8443'],
      'connect-src': ['https://*.example.com'],
      'img-src': ["'self'"],
      'frame-src': ['https://frames.example'],
      'style-src': ['https://styles.example'],
      'font-src': ['https://fonts.example'],
      'form-action': ['https://sign-in.example'],
    };
    const res = await request(app({ csp }), '/');
    const policy = res.headers.get('content-security-policy');
    expect(policy).toBe(contentSecurityPolicy(false, csp));
    expect(policy).toContain("script-src 'self' https://cdn.example:8443");
    expect(policy).toContain("img-src 'self' data: 'self'");
    expect(policy).toContain("frame-src 'self' https://frames.example");
    expect(policy).toContain("object-src 'none'");
    expect(contentSecurityPolicy(false, { 'script-src': [] })).toBe(
      contentSecurityPolicy(false),
    );
  });

  test.each([
    "'unsafe-inline'",
    "'unsafe-eval'",
    'data:',
    '*',
    'http://example.com',
    'https://example.com/',
    'https://example.com/path',
    'https://user@example.com',
    'https://example.com?x',
    'https://example.com#x',
    'https://example.com; script-src *',
    'https://example.com:99999',
    'https://*',
    'https://example.*',
    'https://example.com\n',
  ])('refuses unsafe CSP source %j at app creation', (source) => {
    expect(() => app({ csp: { 'script-src': [source] } })).toThrow(
      'Invalid CSP extension',
    );
  });

  test('rejects unknown directives and malformed source arrays even from untyped callers', () => {
    for (const csp of [
      null,
      [],
      { 'default-src': ["'self'"] },
      { 'script-src': '*' },
      { 'script-src': [null] },
    ]) {
      expect(() => app({ csp: csp as unknown as CspExtensions })).toThrow(
        'Invalid CSP extension',
      );
    }
  });

  test('overrides quickstart before auth and gate landing only for shared-key visitors', async () => {
    const quickstart = vi.fn(
      (c: Context) => `<html>Guide ${c.req.path}</html>`,
    );
    const landing = vi.fn(() => Promise.resolve('<html>Host landing</html>'));
    const a = app({ site: { quickstart, landing } });
    expect(await (await a.request('/quickstart')).text()).toContain(
      'Guide /quickstart',
    );
    expect((await a.request('/')).status).toBe(401);
    expect(landing).not.toHaveBeenCalled();
    const gate = createApp(env.runtime, {
      privateMode: true,
      accessKey: 'k'.repeat(40),
      webRoot: root,
      site: { landing },
      logWriter: () => undefined,
    });
    expect(await (await gate.request('/')).text()).toBe(
      '<html>Host landing</html>',
    );
  });

  test('account URL is optional, validated, and returned in config', async () => {
    expect(
      await (await request(app(), '/api/config')).json(),
    ).not.toHaveProperty('accountUrl');
    const res = await request(
      app({ accountUrl: '/account?tab=billing' }),
      '/api/config',
    );
    expect(ClientConfig.parse(await res.json()).accountUrl).toBe(
      '/account?tab=billing',
    );
    for (const accountUrl of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      'account',
      '/account\n',
      '/\u0000',
    ]) {
      expect(() => app({ accountUrl })).toThrow('accountUrl');
    }
  });

  test('head tags are injected once before closing head on every SPA route and cached', async () => {
    const head = [
      '<script type="module" src="/host.js"></script>',
      '<link rel="stylesheet" href="/host.css">',
      '<link rel="preload" href="/preload.js">',
      '<link rel="modulepreload" href="/module.js"/>',
    ];
    const a = app({ head });
    for (const path of ['/', '/index.html', '/doc/a']) {
      const res = await request(a, path);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`${head.join('\n')}\n</head>`);
      expect(html.match(/src="\/host.js"/g)).toHaveLength(1);
    }
    const original = await readFile(join(root, 'index.html'), 'utf8');
    expect(original).not.toContain('host.js');
    await writeFile(join(root, 'index.html'), '<html>changed</html>');
    expect(await (await request(a, '/doc/b')).text()).toContain('host.js');
  });

  test.each([
    '<script>alert(1)</script>',
    '<script src="/a.js"></script>',
    '<script type="module" src="https://evil.example/a.js"></script>',
    '<script type="module" src="//evil.example/a.js"></script>',
    '<script type="module" src="/\\evil.example/a.js"></script>',
    '<script type="module" src="/&#47;evil.example/a.js"></script>',
    '<script type="module" src="/%2f%2fevil.example/a.js"></script>',
    '<script type="module" src="/a.js" onload="evil()"></script>',
    '<link rel="stylesheet" href="data:text/css,body{}">',
    '<link rel="stylesheet" href="//evil.example/a.css">',
    '<base href="/">',
    '<link rel="stylesheet" href="/a.css">\n<script>alert(1)</script>',
  ])(
    'rejects unsafe head tag %j at app creation, even without a web root',
    (tag) => {
      expect(() => createApp(env.runtime, { head: [tag] })).toThrow(
        'Invalid head tag',
      );
    },
  );
});

describe('pinned document eviction', () => {
  test('forwards pins through normal ingest eviction and public cap reclamation', async () => {
    env.runtime.maxDocs = 1;
    const pinned = new Set<string>();
    const hook = vi.fn((docId: string) => Promise.resolve(pinned.has(docId)));
    const a = app({ pinned: hook });
    const first = await ingest(a);
    pinned.add(first.docId);
    env.serve(
      'https://govinfo.gov/b.txt',
      { bytes: new TextEncoder().encode('Section 1. Second\nA second bill.') },
      'text/plain',
    );
    const second = await ingest(a, 'account:bob', 'https://govinfo.gov/b.txt');
    expect((await env.registry.list()).map((e) => e.docId).sort()).toEqual(
      [first.docId, second.docId].sort(),
    );
    expect(await env.backend.hasDocument(first.docId)).toBe(true);
    // Remove reader references so public reclamation would otherwise choose either document.
    await request(a, `/api/docs/${first.docId}`, 'account:alice', {
      method: 'DELETE',
    });
    await request(a, `/api/docs/${second.docId}`, 'account:bob', {
      method: 'DELETE',
    });
    env.serve(
      'https://govinfo.gov/c.txt',
      { bytes: new TextEncoder().encode('Section 1. Third\nA third bill.') },
      'text/plain',
    );
    const publicApp = createApp(env.runtime, {
      publicMode: true,
      pinned: hook,
      limits: { maxDocs: 2 },
      logWriter: () => undefined,
    });
    const third = await ingest(
      publicApp,
      'ignored',
      'https://govinfo.gov/c.txt',
    );
    expect((await env.registry.list()).map((e) => e.docId).sort()).toEqual(
      [first.docId, third.docId].sort(),
    );
    expect(await env.backend.hasDocument(second.docId)).toBe(false);
  });

  test('rejects malformed head arrays at app creation', () => {
    for (const head of [null, 'not-an-array', [42]]) {
      expect(() => app({ head: head as unknown as string[] })).toThrow(
        'Invalid head tag',
      );
    }
  });
});
