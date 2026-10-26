import { existsSync } from 'node:fs';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { makeSectionedText } from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import type { AskEvent, IngestEvent } from '../core/model/index.js';
import { createHttpApi } from '../web/api.js';
import { envVar } from '../core/brand.js';
import { createLauncher } from './launch.js';
import { startServer, type RunningServer } from './serve.js';
import { sessionCookieName } from './session.js';

let env: PipelineEnv;
let webRoot: string;
let server: RunningServer | undefined;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(
    'https://example.gov/gardens.txt',
    makeSectionedText(),
    'text/plain',
  );
  webRoot = await mkdtemp(join(tmpdir(), 'serve-web-'));
  await writeFile(
    join(webRoot, 'index.html'),
    '<!doctype html><title>UI</title>',
  );
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await env.cleanup();
  await rm(webRoot, { recursive: true, force: true });
});

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of stream) out.push(item);
  return out;
}

async function authenticate(running: RunningServer): Promise<string> {
  const exchange = await fetch(running.url, { redirect: 'manual' });
  expect(exchange.status).toBe(302);
  const cookie = exchange.headers.get('set-cookie')?.split(';')[0];
  await exchange.arrayBuffer();
  if (!cookie) throw new Error('No session cookie');
  return cookie;
}

describe('a real server on loopback', () => {
  test('the launch link opens the document and the key exchange keeps the path but drops the key', async () => {
    const docId = 'b'.repeat(64);
    server = await startServer(env.runtime, {
      port: 0,
      webRoot,
      openPath: `/doc/${docId}`,
    });
    expect(server.url).toMatch(
      new RegExp(
        `^http://127\\.0\\.0\\.1:\\d+/doc/${docId}\\?k=[A-Za-z0-9_-]{43}$`,
      ),
    );
    const exchange = await fetch(server.url, { redirect: 'manual' });
    expect(exchange.status).toBe(302);
    const location = new URL(exchange.headers.get('location')!);
    expect(location.pathname).toBe(`/doc/${docId}`);
    expect(location.search).toBe('');
    await exchange.arrayBuffer();
  });

  test('binds 127.0.0.1 and serves the web index and the API on one origin', async () => {
    server = await startServer(env.runtime, { port: 0, webRoot });
    expect(server.url).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]{43}$/,
    );
    const cookie = await authenticate(server);
    const index = await fetch(new URL('/', server.url), {
      headers: { cookie },
    });
    expect(await index.text()).toContain('<title>UI</title>');
    const health = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/health`,
      { headers: { cookie } },
    );
    expect(await health.json()).toMatchObject({ ok: true });
  });

  test.skipIf(!existsSync(join(process.cwd(), 'dist/web/index.html')))(
    'serves the built web index from dist/web',
    async () => {
      server = await startServer(env.runtime, {
        port: 0,
        webRoot: join(process.cwd(), 'dist/web'),
      });
      const cookie = await authenticate(server);
      const res = await fetch(new URL('/', server.url), {
        headers: { cookie },
      });
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(asset).toBeDefined();
      const js = await fetch(
        `http://127.0.0.1:${String(server.port)}${asset ?? ''}`,
        { headers: { cookie } },
      );
      expect(js.status).toBe(200);
      await js.arrayBuffer(); // an unread body would hold the pooled socket open
    },
  );

  test.for([
    '127.0.0.1',
    '127.0.0.2',
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::ffff:127.0.0.1',
    '::ffff:7f00:2',
    '0:0:0:0:0:ffff:7f00:1',
  ])('refuses DNS rebinding when bound to %s', async (host, context) => {
    try {
      server = await startServer(env.runtime, { port: 0, host });
    } catch (error) {
      // macOS requires loopback aliases to bind 127.0.0.2. The address/Host tables still test
      // these forms on every platform; exercise real sockets wherever the OS supports them.
      if ((error as NodeJS.ErrnoException).code === 'EADDRNOTAVAIL') {
        context.skip();
        return;
      }
      throw error;
    }
    // fetch() will not let a caller override Host, so speak raw HTTP to loopback.
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get(
          {
            host,
            port: server?.port,
            path: '/api/health',
            headers: { host: 'evil.example', origin: 'http://evil.example' },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        )
        .on('error', reject);
    });
    expect(status).toBe(403);
  });

  test('IPv6 loopback has a usable URL and accepts its own Host and Origin', async () => {
    server = await startServer(env.runtime, { port: 0, host: '::1' });
    expect(new URL(server.url).origin).toBe(
      `http://[::1]:${String(server.port)}`,
    );
    const cookie = await authenticate(server);
    const res = await fetch(new URL('/api/health', server.url), {
      headers: { origin: new URL(server.url).origin, cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });

  test('a port already in use gives a plain-language error', async () => {
    server = await startServer(env.runtime, { port: 0 });
    const port = server.port;
    await expect(startServer(env.runtime, { port })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      userMessage: `Port ${String(port)} is already in use. Try --port with another number.`,
    });
  });

  test('the web client works against the real server: ingest, then ask', async () => {
    server = await startServer(env.runtime, { port: 0 });
    const cookie = await authenticate(server);
    const api = createHttpApi({
      baseUrl: new URL(server.url).origin,
      fetchImpl: (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('cookie', cookie);
        return fetch(input, { ...init, headers });
      },
    });

    const config = await api.getConfig();
    expect(config).toMatchObject({ publicMode: false, provider: 'mock' });
    expect(await api.listDocs()).toEqual([]);

    const ingestEvents: IngestEvent[] = await collect(
      api.ingest({ url: 'https://example.gov/gardens.txt', label: 'gardens' }),
    );
    const done = ingestEvents.at(-1);
    if (done?.type !== 'done') throw new Error(JSON.stringify(done));
    expect(done.doc.label).toBe('gardens');

    const detail = await api.getDoc(done.doc.docId);
    const first = detail.outline[0];
    expect(
      (await api.getSection(done.doc.docId, first?.id ?? '')).sectionId,
    ).toBe(first?.id);

    const askEvents: AskEvent[] = await collect(
      api.ask(done.doc.docId, { question: 'Who must file an annual report?' }),
    );
    expect(askEvents[0]?.type).toBe('token');
    const answer = askEvents.at(-1);
    expect(answer?.type).toBe('done');

    // Errors reach the client as plain text, not internal detail.
    const failing = await collect(
      api.ingest({ url: 'https://example.gov/missing' }),
    );
    expect(failing.at(-1)).toEqual({
      type: 'error',
      error: {
        code: 'FETCH_FAILED',
        message: 'The document could not be downloaded.',
      },
    });

    await api.removeDoc(done.doc.docId);
    expect(await api.listDocs()).toEqual([]);
    await expect(api.getDoc(done.doc.docId)).rejects.toMatchObject({
      code: 'DOC_NOT_FOUND',
    });
  });

  test('close stops accepting connections', async () => {
    const running = await startServer(env.runtime, { port: 0 });
    await running.close();
    await expect(
      fetch(`http://127.0.0.1:${String(running.port)}/api/health`),
    ).rejects.toThrow();
  });
});

describe('launcher', () => {
  const fakeServer = (): RunningServer & {
    closed: ReturnType<typeof vi.fn>;
  } => {
    const closed = vi.fn();
    return {
      url: 'http://127.0.0.1:4317/?k=test-launch-token',
      port: 4317,
      closed,
      close: () => {
        closed();
        return Promise.resolve();
      },
    };
  };

  test('a document id becomes the page the launch link opens', async () => {
    const start = vi.fn(() => Promise.resolve(fakeServer()));
    const docId = 'a'.repeat(64);
    await createLauncher({
      start,
      open: vi.fn(),
      env: {},
      write: () => undefined,
      untilStopped: () => Promise.resolve(),
    })(env.runtime, { publicMode: false, docId });
    expect(start).toHaveBeenCalledWith(env.runtime, {
      publicMode: false,
      openPath: `/doc/${docId}`,
    });
  });

  test('starts, prints the address, opens the browser, waits, then closes', async () => {
    const running = fakeServer();
    const start = vi.fn(() => Promise.resolve(running));
    const open = vi.fn();
    let out = '';
    let stop: () => void = () => undefined;
    const launch = createLauncher({
      start,
      open,
      env: {},
      write: (t) => {
        out += t;
      },
      untilStopped: () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    });
    const finished = launch(env.runtime, { publicMode: false, port: 5000 });
    await vi.waitFor(() => {
      expect(open).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/?k=test-launch-token',
      );
    });
    expect(running.closed).not.toHaveBeenCalled();
    stop();
    await finished;
    expect(start).toHaveBeenCalledWith(env.runtime, {
      publicMode: false,
      port: 5000,
    });
    expect(out).toContain('http://127.0.0.1:4317/?k=test-launch-token');
    expect(running.closed).toHaveBeenCalledOnce();
  });

  test.each([
    ['--no-open', { noOpen: true }, {}],
    ['BROWSER=none', {}, { BROWSER: 'none' }],
    ['NO_OPEN=1', {}, { [envVar('NO_OPEN')]: '1' }],
    ['NO_OPEN=true', {}, { [envVar('NO_OPEN')]: 'true' }],
  ])('does not open a browser with %s', async (_name, request, environment) => {
    const open = vi.fn();
    await createLauncher({
      start: vi.fn(() => Promise.resolve(fakeServer())),
      open,
      env: environment,
      write: () => undefined,
      untilStopped: () => Promise.resolve(),
    })(env.runtime, { publicMode: false, ...request });
    expect(open).not.toHaveBeenCalled();
  });

  test('never opens a browser for a public deployment, and passes the host', async () => {
    const start = vi.fn(() => Promise.resolve(fakeServer()));
    const open = vi.fn();
    await createLauncher({
      start,
      open,
      write: () => undefined,
      untilStopped: () => Promise.resolve(),
    })(env.runtime, { publicMode: true, host: '0.0.0.0' });
    expect(open).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(env.runtime, {
      publicMode: true,
      host: '0.0.0.0',
    });
  });

  test('a browser that fails to open does not stop the server', async () => {
    const running = fakeServer();
    await createLauncher({
      start: () => Promise.resolve(running),
      open: () => Promise.reject(new Error('no browser')),
      write: () => undefined,
      untilStopped: () => Promise.resolve(),
    })(env.runtime, { publicMode: false });
    expect(running.closed).toHaveBeenCalledOnce();
  });

  test('the default stop condition is SIGINT', async () => {
    const running = fakeServer();
    const finished = createLauncher({
      start: () => Promise.resolve(running),
      open: () => undefined,
      write: () => undefined,
    })(env.runtime, { publicMode: false });
    await vi.waitFor(() => {
      expect(process.listenerCount('SIGINT')).toBeGreaterThan(0);
    });
    process.emit('SIGINT');
    await finished;
    expect(running.closed).toHaveBeenCalledOnce();
  });
});

describe('launch boundary', () => {
  test.each(['0.0.0.0', '::', '192.168.1.1'])(
    'startServer refuses %s without public mode',
    async (host) => {
      await expect(
        startServer(env.runtime, { host, port: 0 }),
      ).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        userMessage: expect.stringContaining(
          'Local mode has no authentication',
        ) as string,
      });
    },
  );
  test('the launcher validates before calling an injected starter', async () => {
    const start = vi.fn();
    const launch = createLauncher({ start });
    await expect(
      launch(env.runtime, { publicMode: false, host: '0.0.0.0' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(
      launch(env.runtime, { publicMode: true, host: 'evil.example' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(start).not.toHaveBeenCalled();
  });
  test('localhost binds and prints IPv4, and each launch rotates its token', async () => {
    server = await startServer(env.runtime, { host: 'localhost', port: 0 });
    const first = new URL(server.url);
    expect(first.hostname).toBe('127.0.0.1');
    expect(first.searchParams.get('k')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const port = server.port;
    await server.close();
    server = await startServer(env.runtime, { host: 'localhost', port });
    expect(new URL(server.url).searchParams.get('k')).not.toBe(
      first.searchParams.get('k'),
    );
    const response = await fetch(new URL('/api/health', server.url), {
      headers: {
        cookie: `${sessionCookieName(server.port)}=${first.searchParams.get('k') ?? ''}`,
      },
    });
    expect(response.status).toBe(401);
    await response.arrayBuffer();
  });
  test('the session cookie uses the actual port chosen by the listener', async () => {
    server = await startServer(env.runtime, { port: 0 });
    const response = await fetch(server.url, { redirect: 'manual' });
    const cookie = response.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toBe(
      `${sessionCookieName(server.port)}=${new URL(server.url).searchParams.get('k') ?? ''}`,
    );
    await response.arrayBuffer();
    const health = await fetch(new URL('/api/health', server.url), {
      headers: { cookie },
    });
    expect(health.status).toBe(200);
    await health.arrayBuffer();
  });
  test('a public launch link names the document to open, without a key', async () => {
    const docId = 'c'.repeat(64);
    server = await startServer(env.runtime, {
      host: '0.0.0.0',
      publicMode: true,
      port: 0,
      openPath: `/doc/${docId}`,
    });
    expect(server.url).toBe(
      `http://0.0.0.0:${String(server.port)}/doc/${docId}`,
    );
  });
  test('public bind works without a token or cookie, including matching non-loopback Host and Origin', async () => {
    server = await startServer(env.runtime, {
      host: '0.0.0.0',
      publicMode: true,
      port: 0,
    });
    // The public launch link has no key, but still names the page to open.
    expect(server.url).toBe(`http://0.0.0.0:${String(server.port)}/`);
    const response = await new Promise<{
      status: number;
      cookie: string[] | undefined;
    }>((resolve, reject) => {
      http
        .get(
          {
            host: '127.0.0.1',
            port: server?.port,
            path: '/api/health',
            headers: {
              host: 'public.example',
              origin: 'http://public.example',
            },
          },
          (res) => {
            res.resume();
            resolve({
              status: res.statusCode ?? 0,
              cookie: res.headers['set-cookie'],
            });
          },
        )
        .on('error', reject);
    });
    expect(response).toEqual({ status: 200, cookie: undefined });
  });
  test('--no-open prints the launch URL exactly once and never opens it', async () => {
    const open = vi.fn();
    let output = '';
    let url = '';
    await createLauncher({
      start: async (runtime, options) => {
        const running = await startServer(runtime, { ...options, port: 0 });
        url = running.url;
        return running;
      },
      open,
      write: (text) => {
        output += text;
      },
      untilStopped: () => Promise.resolve(),
    })(env.runtime, { publicMode: false, noOpen: true });
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?k=[A-Za-z0-9_-]{43}$/);
    expect(output).toBe(`\nServing at ${url} (press Ctrl+C to stop)\n`);
    expect(open).not.toHaveBeenCalled();
  });
  test('callers cannot override the address-derived localOnly guard', async () => {
    server = await startServer(env.runtime, {
      host: '::ffff:127.0.0.1',
      port: 0,
      localOnly: false,
    });
    const response = await fetch(new URL('/api/health', server.url), {
      headers: { host: 'evil.example', origin: 'http://evil.example' },
    });
    expect(response.status).toBe(403);
    await response.arrayBuffer();
  });
});

test('private launcher prints a placeholder, never a key or tokenized link, and never opens', async () => {
  const accessKey = 'k'.repeat(40);
  const start = vi.fn(() =>
    Promise.resolve({
      url: 'http://0.0.0.0:8080/?k=should-never-print',
      port: 8080,
      close: () => Promise.resolve(),
    }),
  );
  const open = vi.fn();
  let output = '';
  await createLauncher({
    start,
    open,
    env: {
      [envVar('ACCESS_KEY')]: accessKey,
      [envVar('PUBLIC_ORIGIN')]: 'https://preview.example',
    },
    write: (text) => {
      output += text;
    },
    untilStopped: () => Promise.resolve(),
  })(env.runtime, {
    publicMode: false,
    privateMode: true,
    host: '0.0.0.0',
    trustProxyHops: 1,
  });
  expect(output).toBe(
    '\nPrivate mode on http://0.0.0.0:8080. Share https://preview.example/?k=<access key> with invited people.\n',
  );
  expect(output).not.toContain(accessKey);
  expect(output).not.toContain('should-never-print');
  expect(open).not.toHaveBeenCalled();
  expect(start).toHaveBeenCalledWith(
    env.runtime,
    expect.objectContaining({
      privateMode: true,
      accessKey,
      trustProxyHops: 1,
    }),
  );
});

test('private server permits network binds without generating a launch token', async () => {
  const accessKey = 'x'.repeat(32);
  server = await startServer(env.runtime, {
    privateMode: true,
    accessKey,
    host: '0.0.0.0',
    port: 0,
  });
  expect(new URL(server.url).search).toBe('');
  const url = `http://127.0.0.1:${String(server.port)}`;
  const response = await fetch(url);
  expect(await response.text()).toContain('This is a private preview.');
  const exchange = await fetch(`${url}/?k=${accessKey}`, {
    redirect: 'manual',
  });
  expect(exchange.headers.get('location')).toBe('/');
  expect(exchange.headers.get('set-cookie')).toContain('Secure');
  await exchange.arrayBuffer();
});
