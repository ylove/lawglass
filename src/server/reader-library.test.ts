import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdirSync } from 'node:fs';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import {
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import { makeInjectionText } from '../../tests/synth/injection.js';
import { IngestEvent, type DocSummary } from '../core/model/index.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions } from './app.js';
import { envVar } from '../core/brand.js';
import { privateCookieValue, SESSION_COOKIE } from './session.js';
import { READER_COOKIE, readerKey } from './readers.js';

const accessKey = 'k'.repeat(40);
const session = `${SESSION_COOKIE}=${privateCookieValue(accessKey)}`;
const urls = {
  a: 'https://govinfo.gov/a.txt',
  b: 'https://govinfo.gov/b.xml',
  c: 'https://govinfo.gov/c.txt',
};
let env: PipelineEnv;
let root: string;
beforeEach(async () => {
  env = await makePipelineEnv();
  // A small cap so a third document forces an eviction.
  (env.runtime as { maxDocs: number }).maxDocs = 2;
  env.serve(urls.a, makeSectionedText(), 'text/plain');
  env.serve(urls.b, makeCongressionalBillXml());
  env.serve(urls.c, makeInjectionText(0), 'text/plain');
  root = await mkdtemp(join(tmpdir(), 'reader-web-'));
});
afterEach(async () => {
  await env.cleanup();
  await rm(root, { recursive: true, force: true });
});

const privateApp = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    privateMode: true,
    accessKey,
    logWriter: () => undefined,
    ...options,
  });
const publicApp = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    publicMode: true,
    logWriter: () => undefined,
    limits: { ingestsPerHour: 100 },
    clientIp: () => 'ip',
    ...options,
  });

/** One browser: keeps its own reader cookie, the way a cookie jar would. */
function browser(app: Hono, readerId?: string, withSession = true) {
  let reader = readerId;
  const request = async (path: string, init: RequestInit = {}) => {
    const cookies = [
      ...(withSession ? [session] : []),
      ...(reader ? [`${READER_COOKIE}=${reader}`] : []),
    ].join('; ');
    const res = await app.request(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(cookies ? { cookie: cookies } : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    const set = res.headers.get('set-cookie');
    const issued = set?.match(new RegExp(`${READER_COOKIE}=([^;]*)`))?.at(1);
    if (issued) reader = issued;
    return res;
  };
  const ingest = async (url: string) => {
    const res = await request('/api/ingest', {
      method: 'POST',
      body: JSON.stringify({ url }),
    });
    const events = [];
    for await (const e of readSseEvents(res, IngestEvent)) events.push(e);
    const done = events.at(-1);
    if (done?.type !== 'done') throw new Error(JSON.stringify(done));
    return done;
  };
  const list = async (): Promise<DocSummary[]> =>
    (await request('/api/docs')).json() as Promise<DocSummary[]>;
  return {
    request,
    ingest,
    list,
    get id() {
      return reader;
    },
  };
}

describe.each([
  ['private', privateApp],
  ['public', publicApp],
] as const)('%s mode reader library', (mode, make) => {
  const open = (app: Hono, id?: string) => browser(app, id, mode === 'private');

  test('two readers are isolated, and a reused ingest adds to the second list', async () => {
    const app = make();
    const a = open(app);
    const b = open(app);
    const first = await a.ingest(urls.a);
    expect(await a.list()).toHaveLength(1);
    expect(await b.list()).toEqual([]);
    expect(a.id).not.toBe(b.id);

    const again = await b.ingest(urls.a);
    expect(again.stats.reused).toBe(true);
    expect((await b.list()).map((d) => d.docId)).toEqual([first.doc.docId]);
  });

  test('opening a document lists it for that reader and moves it to the top', async () => {
    const app = make();
    const a = open(app);
    const one = await a.ingest(urls.a);
    const two = await a.ingest(urls.b);
    expect((await a.list()).map((d) => d.docId)).toEqual([
      two.doc.docId,
      one.doc.docId,
    ]);
    const b = open(app);
    // A shared /doc/<id> link works for anyone and adds the document to their list.
    expect((await b.request(`/api/docs/${one.doc.docId}`)).status).toBe(200);
    expect((await b.list()).map((d) => d.docId)).toEqual([one.doc.docId]);
    await new Promise((r) => setTimeout(r, 5));
    await a.request(`/api/docs/${one.doc.docId}`);
    expect((await a.list()).map((d) => d.docId)).toEqual([
      one.doc.docId,
      two.doc.docId,
    ]);
  });

  test('DELETE removes the document from one list only', async () => {
    const app = make();
    const a = open(app);
    const b = open(app);
    const { doc } = await a.ingest(urls.a);
    await b.ingest(urls.a);
    const res = await a.request(`/api/docs/${doc.docId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await a.list()).toEqual([]);
    expect(await b.list()).toHaveLength(1);
    expect(await env.registry.list()).toHaveLength(1);
    // The shared store still serves it to anyone.
    expect((await a.request(`/api/docs/${doc.docId}`)).status).toBe(200);
    // Removing again is harmless.
    expect(
      (await a.request(`/api/docs/${doc.docId}`, { method: 'DELETE' })).status,
    ).toBe(204);
  });

  test('config reports a reader library and the configured examples', async () => {
    const app = make({
      examples: [{ label: 'Example', url: 'https://govinfo.gov/a.txt' }],
    });
    const res = await open(app).request('/api/config');
    expect(await res.json()).toMatchObject({
      library: 'reader',
      examples: [{ label: 'Example', url: 'https://govinfo.gov/a.txt' }],
    });
  });

  test('the reader cookie is HttpOnly, Secure, SameSite=Strict, a year long, and set once', async () => {
    const app = make();
    const b = open(app);
    const res = await b.request('/api/config');
    const set = res.headers.get('set-cookie')!;
    expect(set).toContain(`${READER_COOKIE}=`);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/Secure/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\//i);
    expect(set).toContain('Max-Age=31536000');
    // With a valid cookie in hand no new one is issued.
    const again = await b.request('/api/config');
    expect(again.headers.get('set-cookie') ?? '').not.toContain(READER_COOKIE);
  });

  test.each(['../x', '../../etc/passwd', 'a'.repeat(5000), 'not base64url!!'])(
    'a bad cookie %#  gets a fresh id and never reaches the filesystem',
    async (bad) => {
      const app = make();
      const b = open(app, bad);
      await b.ingest(urls.a);
      expect(b.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
      expect(b.id).not.toBe(bad);
      const dir = join(env.runtime.registry.configDir, 'readers');
      const names = await readdir(dir);
      expect(names).toEqual([`${readerKey(b.id!)}.json`]);
      // Nothing was written next to the config directory either.
      expect(
        readdirSync(join(env.runtime.registry.configDir, '..')).filter((n) =>
          n.includes('passwd'),
        ),
      ).toEqual([]);
    },
  );

  test('eviction prefers documents no reader lists', async () => {
    const app = make();
    const a = open(app);
    const b = open(app);
    const one = await a.ingest(urls.a);
    const two = await b.ingest(urls.b);
    await b.request(`/api/docs/${two.doc.docId}`, { method: 'DELETE' });
    if (mode === 'public') {
      // Public servers refuse ingests at the cap rather than evicting.
      const res = await a.request('/api/ingest', {
        method: 'POST',
        body: JSON.stringify({ url: urls.c }),
      });
      expect(res.status).toBe(403);
      return;
    }
    await a.ingest(urls.c);
    const left = (await env.registry.list()).map((e) => e.docId).sort();
    expect(left).toContain(one.doc.docId);
    expect(left).not.toContain(two.doc.docId);
    expect(left).toHaveLength(2);
    expect((await a.list()).map((d) => d.docId)).toContain(one.doc.docId);
    // The evicted document silently drops out of any list that still named it.
    expect((await b.list()).map((d) => d.docId)).not.toContain(two.doc.docId);
  });
});

describe('private mode specifics', () => {
  test('no reader id is issued to a gated visitor', async () => {
    const app = privateApp();
    const res = await app.request('/api/docs');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie') ?? '').not.toContain(READER_COOKIE);
  });

  test('/doc/<id> is gated without a session and served with one', async () => {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(root, 'index.html'), '<div id="root">SPA</div>');
    const app = privateApp({ webRoot: root });
    const id = 'a'.repeat(64);
    const gated = await app.request(`/doc/${id}`);
    expect(gated.status).toBe(200);
    expect(await gated.text()).not.toContain('SPA');
    const ok = await app.request(`/doc/${id}`, {
      headers: { cookie: session },
    });
    expect(await ok.text()).toContain('SPA');
  });
});

describe('local mode', () => {
  test('lists everything, reports a local library and issues no reader cookie', async () => {
    const app = createApp(env.runtime, {
      sessionToken: 't',
      logWriter: () => undefined,
    });
    const cookie = (await app.request('http://127.0.0.1/?k=t')).headers
      .get('set-cookie')!
      .split(';')[0]!;
    const headers = { cookie, 'content-type': 'application/json' };
    const res = await app.request('/api/ingest', {
      method: 'POST',
      headers,
      body: JSON.stringify({ url: urls.a }),
    });
    await res.text();
    expect(res.headers.get('set-cookie') ?? '').not.toContain(READER_COOKIE);
    const config = await (await app.request('/api/config', { headers })).json();
    expect(config).toMatchObject({ library: 'local' });
    const docs = (await (
      await app.request('/api/docs', { headers })
    ).json()) as DocSummary[];
    expect(docs).toHaveLength(1);
    const del = await app.request(`/api/docs/${docs[0]!.docId}`, {
      method: 'DELETE',
      headers,
    });
    expect(del.status).toBe(204);
    expect(await env.registry.list()).toEqual([]);
  });

  test('an invalid examples value is ignored with a log line, not a crash', async () => {
    const lines: string[] = [];
    vi.stubEnv(envVar('EXAMPLES'), '[{"label":"","url":"nope"}]');
    try {
      const app = createApp(env.runtime, {
        sessionToken: 't',
        logWriter: (line) => lines.push(line),
      });
      const cookie = (await app.request('http://127.0.0.1/?k=t')).headers
        .get('set-cookie')!
        .split(';')[0]!;
      const config = (await (
        await app.request('/api/config', { headers: { cookie } })
      ).json()) as { examples?: unknown };
      expect(config.examples).toBeUndefined();
      expect(lines.join('')).toContain('examples_invalid');
      expect(lines.join('')).not.toContain('nope');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('valid examples come through from the environment', async () => {
    vi.stubEnv(
      envVar('EXAMPLES'),
      '[{"label":"One","url":"https://www.congress.gov/bill/1"}]',
    );
    try {
      const app = createApp(env.runtime, { sessionToken: 't' });
      const cookie = (await app.request('http://127.0.0.1/?k=t')).headers
        .get('set-cookie')!
        .split(';')[0]!;
      const config = (await (
        await app.request('/api/config', { headers: { cookie } })
      ).json()) as { examples?: unknown };
      expect(config.examples).toEqual([
        { label: 'One', url: 'https://www.congress.gov/bill/1' },
      ]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
