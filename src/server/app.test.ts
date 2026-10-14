import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ZodType } from 'zod';
import {
  makeAmendmentHtml,
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import {
  AskEvent,
  AppError,
  ClientConfig,
  DocDetail,
  DocSummary,
  IngestEvent,
  SectionExcerpt,
  walkSections,
  type AnswerResult,
  type NormalizedDoc,
} from '../core/model/index.js';
import type { ChipRunner } from '../core/pipeline/index.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, toErrorPayload, type AppOptions } from './app.js';

const GARDENS = 'https://example.gov/gardens.txt';
const BILL = 'https://example.gov/s9001.xml';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(GARDENS, makeSectionedText(), 'text/plain');
  env.serve(BILL, makeCongressionalBillXml());
  env.serve(
    'https://example.gov/permit.html',
    makeAmendmentHtml(),
    'text/html',
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, { localOnly: false, ...options });

const post = (
  a: Hono,
  path: string,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> | Response =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...init,
  });

async function events<T>(res: Response, schema: ZodType<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of readSseEvents(res, schema)) out.push(event);
  return out;
}

async function ingestDoc(a: Hono, url = GARDENS): Promise<DocSummary> {
  const res = await post(a, '/api/ingest', { url });
  const done = (await events(res, IngestEvent)).find((e) => e.type === 'done');
  if (done?.type !== 'done') throw new Error('ingest did not finish');
  return done.doc;
}

describe('basic routes', () => {
  test('health and config', async () => {
    const a = app();
    const health = await a.request('/api/health');
    expect(await health.json()).toMatchObject({ ok: true });
    const config = ClientConfig.parse(
      await (await a.request('/api/config')).json(),
    );
    expect(config).toMatchObject({
      publicMode: false,
      freeformEnabled: true,
      backend: 'local',
      provider: 'mock',
    });
    expect(config.chips).toHaveLength(8);
  });

  test('config still loads when no provider is configured', async () => {
    const runtime = Object.create(env.runtime, {
      answerProvider: {
        get: () => {
          throw new AppError('MISSING_KEY');
        },
      },
    }) as typeof env.runtime;
    const res = await createApp(runtime, { localOnly: false }).request(
      '/api/config',
    );
    expect(await res.json()).toMatchObject({ provider: 'none', model: '' });
  });

  test('public mode is reflected in config', async () => {
    const config = ClientConfig.parse(
      await (await app({ publicMode: true }).request('/api/config')).json(),
    );
    expect(config).toMatchObject({ publicMode: true, freeformEnabled: false });
  });

  test('unknown API paths are JSON 404s', async () => {
    const res = await app().request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({
      error: { code: 'DOC_NOT_FOUND' },
    });
  });

  test('toErrorPayload hides internal error text', () => {
    expect(toErrorPayload(new Error('stack secret'))).toEqual({
      code: 'INTERNAL',
      message: 'Something went wrong. Please try again.',
    });
  });

  test('unexpected errors become a generic 500', async () => {
    vi.spyOn(env.registry, 'list').mockRejectedValue(new Error('disk secret'));
    const res = await app().request('/api/docs');
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('secret');
  });
});

describe('ingest and documents', () => {
  test('streams progress then done; the doc is then listed, detailed and excerpted', async () => {
    const a = app();
    const res = await post(a, '/api/ingest', { url: GARDENS, label: 'garden' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evs = await events(res, IngestEvent);
    expect(evs[0]).toMatchObject({ type: 'progress', stage: 'fetching' });
    expect(
      evs.some((e) => e.type === 'progress' && e.stage === 'embedding'),
    ).toBe(true);
    const done = evs.at(-1);
    expect(done).toMatchObject({
      type: 'done',
      doc: { label: 'garden', format: 'text' },
      stats: { reused: false },
    });

    const list = (await (await a.request('/api/docs')).json()) as unknown[];
    expect(list.map((d) => DocSummary.parse(d).label)).toEqual(['garden']);
    // The registry's usage counters are not part of the public summary.
    expect(list[0]).not.toHaveProperty('usage');

    const docId = (done as { doc: DocSummary }).doc.docId;
    const detail = DocDetail.parse(
      await (await a.request(`/api/docs/${docId}`)).json(),
    );
    expect(detail.outline.length).toBeGreaterThan(3);
    expect(detail.hasLineNumbers).toBe(false);

    const first = detail.outline[0];
    const excerpt = SectionExcerpt.parse(
      await (
        await a.request(
          `/api/docs/${docId}/sections/${encodeURIComponent(first?.id ?? '')}`,
        )
      ).json(),
    );
    expect(excerpt.sectionId).toBe(first?.id);
    expect(excerpt.spans.length).toBeGreaterThan(0);
  });

  test('an excerpt for a parent section includes its children', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const stored: NormalizedDoc = await env.registry.getDocument(doc.docId);
    const parent = [...walkSections(stored.sections)].find(
      (s) =>
        s.children.length > 0 &&
        s.children.every((c) => c.children.length === 0),
    );
    if (!parent) throw new Error('fixture has no nested section');
    const excerpt = SectionExcerpt.parse(
      await (
        await a.request(
          `/api/docs/${doc.docId}/sections/${encodeURIComponent(parent.id)}`,
        )
      ).json(),
    );
    const child = parent.children[0];
    expect(excerpt.spans.map((s) => s.text).join('')).toContain(
      child?.spans[0]?.text ?? 'missing',
    );
  });

  test('re-ingesting the same bytes reports reuse', async () => {
    const a = app();
    await ingestDoc(a);
    const evs = await events(
      await post(a, '/api/ingest', { url: GARDENS }),
      IngestEvent,
    );
    expect(evs.at(-1)).toMatchObject({ type: 'done', stats: { reused: true } });
  });

  test('the list puts the most recently used document first', async () => {
    const a = app();
    await ingestDoc(a, BILL);
    const second = await ingestDoc(a, GARDENS);
    const list = (await (await a.request('/api/docs')).json()) as DocSummary[];
    expect(list[0]?.docId).toBe(second.docId);
  });

  test('DELETE removes the doc from the registry and backend', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const res = await a.request(`/api/docs/${doc.docId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await env.registry.list()).toHaveLength(0);
    expect(await env.backend.hasDocument(doc.docId)).toBe(false);
    expect((await a.request(`/api/docs/${doc.docId}`)).status).toBe(404);
    expect(
      (await a.request(`/api/docs/${doc.docId}`, { method: 'DELETE' })).status,
    ).toBe(404);
  });

  test('unknown doc and unknown section are 404 with a plain message', async () => {
    const a = app();
    const missing = await a.request('/api/docs/deadbeef/sections/x');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      error: {
        code: 'DOC_NOT_FOUND',
        message: 'That document has not been loaded.',
      },
    });
    const doc = await ingestDoc(a);
    const section = await a.request(`/api/docs/${doc.docId}/sections/nope`);
    expect(section.status).toBe(404);
  });

  test('a bad request body is a 400 before any stream starts', async () => {
    const a = app();
    for (const body of [{ url: 'not a url' }, {}, 'text']) {
      const res = await post(a, '/api/ingest', body);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: { code: 'INVALID_INPUT' },
      });
    }
    const raw = await a.request('/api/ingest', {
      method: 'POST',
      body: '{broken',
    });
    expect(raw.status).toBe(400);
  });

  test('a wrapper page streams candidate links instead of an error', async () => {
    // The injected fetcher is not safeFetch, so raise the wrapper error it would raise.
    env.runtime.fetcher = () =>
      Promise.reject(
        new AppError('WRAPPER_PAGE', undefined, {
          details: {
            links: [
              {
                url: 'https://example.gov/bill.pdf',
                text: 'Full text PDF',
                format: 'pdf',
              },
            ],
          },
        }),
      );
    const evs = await events(
      await post(app(), '/api/ingest', {
        url: 'https://example.gov/wrapper.html',
      }),
      IngestEvent,
    );
    expect(evs.at(-1)).toMatchObject({
      type: 'candidates',
      links: [{ url: 'https://example.gov/bill.pdf', format: 'pdf' }],
    });
  });
});

describe('error events carry the plain-language message', () => {
  test('an AppError from the pipeline shows its userMessage', async () => {
    const evs = await events(
      await post(app(), '/api/ingest', { url: 'https://example.gov/missing' }),
      IngestEvent,
    );
    expect(evs.at(-1)).toEqual({
      type: 'error',
      error: {
        code: 'FETCH_FAILED',
        message: 'The document could not be downloaded.',
      },
    });
  });

  test('a non-AppError becomes a generic message, never internal text', async () => {
    env.runtime.fetcher = () => Promise.reject(new Error('ECONNRESET /etc/x'));
    const evs = await events(
      await post(app(), '/api/ingest', { url: GARDENS }),
      IngestEvent,
    );
    const last = evs.at(-1);
    expect(last).toMatchObject({
      type: 'error',
      error: {
        code: 'INTERNAL',
        message: 'Something went wrong. Please try again.',
      },
    });
    expect(JSON.stringify(last)).not.toContain('ECONNRESET');
  });

  test('ask errors use the userMessage too (missing provider key)', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const runtime = Object.create(env.runtime, {
      answerProvider: {
        get: () => {
          throw new AppError('MISSING_KEY');
        },
      },
    }) as typeof env.runtime;
    const res = await post(
      createApp(runtime, { localOnly: false }),
      `/api/docs/${doc.docId}/ask`,
      { question: 'What is this?' },
    );
    const evs = await events(res, AskEvent);
    expect(evs.at(-1)).toMatchObject({
      type: 'error',
      error: {
        code: 'MISSING_KEY',
        message:
          'An API key is missing. Run `init` or set the environment variable.',
      },
    });
  });

  test('a chip with no runner explains itself', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const evs = await events(
      await post(a, `/api/docs/${doc.docId}/ask`, { chipId: 'summary' }),
      AskEvent,
    );
    expect(evs.at(-1)).toMatchObject({
      type: 'error',
      error: { code: 'INVALID_INPUT' },
    });
  });
});

describe('ask', () => {
  test('streams token events then retrieval then done with the AnswerResult', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const res = await post(a, `/api/docs/${doc.docId}/ask`, {
      question: 'Who must file an annual report?',
    });
    const evs = await events(res, AskEvent);
    const types = evs.map((e) => e.type);
    expect(types[0]).toBe('token');
    expect(types.at(-1)).toBe('done');
    expect(types).toContain('retrieval');
    expect(types.indexOf('retrieval')).toBeGreaterThan(
      types.lastIndexOf('token'),
    );
    const done = evs.at(-1);
    const streamed = evs.flatMap((e) => (e.type === 'token' ? [e.text] : []));
    expect(done).toMatchObject({
      type: 'done',
      answer: { text: streamed.join('') },
    });
  });

  test('rejects bodies that are not exactly one of chip or question', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    for (const body of [
      {},
      { chipId: 'summary', question: 'x' },
      { chipId: 'zzz' },
    ]) {
      const res = await post(a, `/api/docs/${doc.docId}/ask`, body);
      expect(res.status).toBe(400);
    }
  });

  test('an unknown doc is a 404 before streaming', async () => {
    const res = await post(app(), '/api/docs/nope/ask', { question: 'hi' });
    expect(res.status).toBe(404);
  });

  test('chips run through the injected runner', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    const answer = await freeformAnswer(a, doc.docId);
    const chips: ChipRunner = (_id, _doc, _ctx, opts) => {
      opts.onToken?.('hello');
      return Promise.resolve({
        answer,
        hits: [],
        backendUsage: {
          embedTokens: 0,
          rerankUnits: 0,
          readUnits: 0,
          writeUnits: 0,
        },
      });
    };
    env.runtime.chips = chips;
    const evs = await events(
      await post(a, `/api/docs/${doc.docId}/ask`, { chipId: 'summary' }),
      AskEvent,
    );
    expect(evs.map((e) => e.type)).toEqual(['token', 'retrieval', 'done']);
  });
});

async function freeformAnswer(a: Hono, docId: string): Promise<AnswerResult> {
  const evs = await events(
    await post(a, `/api/docs/${docId}/ask`, { question: 'What is this?' }),
    AskEvent,
  );
  const done = evs.at(-1);
  if (done?.type !== 'done') throw new Error('no answer');
  return done.answer;
}

describe('abort and heartbeat', () => {
  test.each(['body parsing', 'document lookup', 'public checks'])(
    'an ask cancelled during %s never starts the chip runner',
    async (phase) => {
      const doc = await ingestDoc(app());
      const controller = new AbortController();
      const body = { chipId: 'summary' };
      const request = new Request(
        `http://localhost/api/docs/${doc.docId}/ask`,
        {
          method: 'POST',
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json' },
          signal: controller.signal,
        },
      );
      if (phase === 'body parsing')
        vi.spyOn(request, 'text').mockImplementation(() => {
          controller.abort();
          return Promise.resolve(JSON.stringify(body));
        });
      if (phase === 'document lookup') {
        const list = env.registry.list.bind(env.registry);
        vi.spyOn(env.registry, 'list').mockImplementationOnce(async () => {
          const entries = await list();
          controller.abort();
          return entries;
        });
      }
      const chips = vi
        .fn<ChipRunner>()
        .mockRejectedValue(new Error('must not run'));
      env.runtime.chips = chips;
      const a = app({
        publicMode: true,
        turnstile: () => {
          if (phase === 'public checks') controller.abort();
          return Promise.resolve(true);
        },
      });
      const res = await a.request(request);
      expect(await res.text()).toBe('');
      expect(controller.signal.aborted).toBe(true);
      expect(chips).not.toHaveBeenCalled();
    },
  );

  test.each(['body parsing', 'public checks'])(
    'an ingest cancelled during %s never fetches and releases its admission slot',
    async (phase) => {
      const controller = new AbortController();
      const body = { url: GARDENS };
      const request = new Request('http://localhost/api/ingest', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
      });
      if (phase === 'body parsing')
        vi.spyOn(request, 'text').mockImplementation(() => {
          controller.abort();
          return Promise.resolve(JSON.stringify(body));
        });
      const fetcher = vi.spyOn(env.runtime, 'fetcher');
      const a = app({
        publicMode: true,
        limits: { maxDocs: 1 },
        turnstile: () => {
          if (phase === 'public checks') controller.abort();
          return Promise.resolve(true);
        },
      });
      const res = await a.request(request);
      expect(await res.text()).toBe('');
      expect(fetcher).not.toHaveBeenCalled();
      expect(await env.registry.list()).toEqual([]);
      await ingestDoc(a);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  test('aborting an ask cancels the pipeline signal and sends nothing more', async () => {
    const a = app();
    const doc = await ingestDoc(a);
    let seen: AbortSignal | undefined;
    env.runtime.chips = (_id, _doc, _ctx, opts) =>
      new Promise((_resolve, reject) => {
        seen = opts.signal;
        opts.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const controller = new AbortController();
    const res = await post(
      a,
      `/api/docs/${doc.docId}/ask`,
      { chipId: 'summary' },
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    controller.abort();
    await vi.waitFor(() => {
      expect(seen?.aborted).toBe(true);
    });
    await res.body?.cancel().catch(() => undefined);
  });

  test('aborting an ingest cancels the fetch signal', async () => {
    let seen: AbortSignal | undefined;
    env.runtime.fetcher = (_url, opts) =>
      new Promise((_resolve, reject) => {
        seen = opts?.signal;
        opts?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    const controller = new AbortController();
    const res = await post(
      app(),
      '/api/ingest',
      { url: GARDENS },
      {
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => {
      expect(seen).toBeDefined();
    });
    controller.abort();
    await vi.waitFor(() => {
      expect(seen?.aborted).toBe(true);
    });
    await res.body?.cancel().catch(() => undefined);
  });

  test('long-running streams carry heartbeat comments', async () => {
    const a = app({ heartbeatMs: 5 });
    const doc = await ingestDoc(a);
    let release: () => void = () => undefined;
    env.runtime.chips = () =>
      new Promise((_resolve, reject) => {
        release = () => {
          reject(new AppError('PROVIDER_ERROR'));
        };
      });
    const res = await post(a, `/api/docs/${doc.docId}/ask`, {
      chipId: 'summary',
    });
    const reader = res.body?.getReader();
    let text = '';
    while (!text.includes(': ping')) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += new TextDecoder().decode(chunk.value as Uint8Array);
    }
    expect(text).toContain(': ping\n\n');
    release();
    await reader?.cancel();
  });
});

describe('local-only protections', () => {
  test('rejects a non-loopback Host header', async () => {
    const a = createApp(env.runtime);
    const bad = await a.request('http://evil.example/api/health');
    expect(bad.status).toBe(403);
    expect((await a.request('http://localhost:4317/api/health')).status).toBe(
      200,
    );
    expect((await a.request('http://127.0.0.1:4317/api/health')).status).toBe(
      200,
    );
  });

  test('rejects cross-origin API calls', async () => {
    const a = createApp(env.runtime);
    const headers = { origin: 'https://evil.example' };
    expect(
      (await a.request('http://localhost/api/health', { headers })).status,
    ).toBe(403);
    expect(
      (
        await a.request('http://localhost/api/health', {
          headers: { origin: 'http://localhost' },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await a.request('http://localhost/api/health', {
          headers: { origin: 'not a url' },
        })
      ).status,
    ).toBe(403);
  });
});

describe('static web assets', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'web-root-'));
    await mkdir(join(root, 'assets'));
    await writeFile(
      join(root, 'index.html'),
      '<!doctype html><title>x</title>',
    );
    await writeFile(join(root, 'assets', 'app.js'), 'console.log(1)');
    await writeFile(join(root, 'assets', 'blob.bin'), 'x');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test('serves index, assets with types, and falls back for client routes', async () => {
    const a = app({ webRoot: root });
    const index = await a.request('/');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('<title>x</title>');
    const js = await a.request('/assets/app.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(
      (await a.request('/assets/blob.bin')).headers.get('content-type'),
    ).toBe('application/octet-stream');
    expect(await (await a.request('/some/route')).text()).toContain('<title>');
  });

  test('missing assets, traversal and unknown API paths stay 404', async () => {
    const a = app({ webRoot: root });
    expect((await a.request('/assets/missing.js')).status).toBe(404);
    expect((await a.request('/assets')).status).toBe(200); // directory -> client route fallback
    expect((await a.request('/..%2f..%2fetc%2fpasswd')).status).not.toBe(500);
    const escaped = await a.request('/%2e%2e/%2e%2e/etc/passwd');
    expect(await escaped.text()).not.toContain('root:');
    const api = await a.request('/api/missing');
    expect(api.headers.get('content-type')).toContain('json');
    expect(api.status).toBe(404);
  });

  test('POST to a page path is not served the index', async () => {
    const res = await app({ webRoot: root }).request('/', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
