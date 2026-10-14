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
import { createLauncher } from './launch.js';
import { startServer, type RunningServer } from './serve.js';

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

describe('a real server on loopback', () => {
  test('binds 127.0.0.1 and serves the web index and the API on one origin', async () => {
    server = await startServer(env.runtime, { port: 0, webRoot });
    expect(server.url).toMatch(/^http:\/\/localhost:\d+$/);
    const index = await fetch(`http://127.0.0.1:${String(server.port)}/`);
    expect(await index.text()).toContain('<title>UI</title>');
    const health = await fetch(
      `http://127.0.0.1:${String(server.port)}/api/health`,
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
      const res = await fetch(`http://127.0.0.1:${String(server.port)}/`);
      expect(res.headers.get('content-type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('<div id="root">');
      const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
      expect(asset).toBeDefined();
      const js = await fetch(
        `http://127.0.0.1:${String(server.port)}${asset ?? ''}`,
      );
      expect(js.status).toBe(200);
      await js.arrayBuffer(); // an unread body would hold the pooled socket open
    },
  );

  test.each(['127.0.0.1', '::1'])(
    'refuses DNS rebinding when bound to %s',
    async (host) => {
      server = await startServer(env.runtime, { port: 0, host });
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
    },
  );

  test('IPv6 loopback has a usable URL and accepts its own Host and Origin', async () => {
    server = await startServer(env.runtime, { port: 0, host: '::1' });
    expect(server.url).toBe(`http://[::1]:${String(server.port)}`);
    const res = await fetch(`${server.url}/api/health`, {
      headers: { origin: server.url },
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
    const api = createHttpApi({
      baseUrl: `http://127.0.0.1:${String(server.port)}`,
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
      url: 'http://localhost:4317',
      port: 4317,
      closed,
      close: () => {
        closed();
        return Promise.resolve();
      },
    };
  };

  test('starts, prints the address, opens the browser, waits, then closes', async () => {
    const running = fakeServer();
    const start = vi.fn(() => Promise.resolve(running));
    const open = vi.fn();
    let out = '';
    let stop: () => void = () => undefined;
    const launch = createLauncher({
      start,
      open,
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
      expect(open).toHaveBeenCalledWith('http://localhost:4317');
    });
    expect(running.closed).not.toHaveBeenCalled();
    stop();
    await finished;
    expect(start).toHaveBeenCalledWith(env.runtime, {
      publicMode: false,
      port: 5000,
    });
    expect(out).toContain('http://localhost:4317');
    expect(running.closed).toHaveBeenCalledOnce();
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
