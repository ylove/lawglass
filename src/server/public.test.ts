import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ZodType } from 'zod';
import {
  makeCongressionalBillXml,
  makeSectionedText,
} from '../../tests/synth/index.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import {
  AskEvent,
  IngestEvent,
  type AnswerResult,
  type NormalizedDoc,
} from '../core/model/index.js';
import type { ChipRunner } from '../core/pipeline/index.js';
import { scenarioProvider } from '../../tests/support/scenario-provider.js';
import { scenarioExcerpts } from '../../tests/synth/scenario.js';
import { readSseEvents } from '../web/sse.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import type { AppOptions } from './app.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve('https://govinfo.gov/a.txt', makeSectionedText(), 'text/plain');
  env.serve('https://govinfo.gov/b.xml', makeCongressionalBillXml());
});
afterEach(async () => {
  await env.cleanup();
});

/** Public app whose client address comes from an `x-ip` header, so tests can play several users. */
const publicApp = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    publicMode: true,
    clientIp: (c) => c.req.header('x-ip') ?? 'unknown',
    ...options,
  });

const post = (a: Hono, path: string, body: unknown, ip = '1.1.1.1') =>
  a.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ip': ip },
    body: JSON.stringify(body),
  });

async function events<T>(res: Response, schema: ZodType<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const event of readSseEvents(res, schema)) out.push(event);
  return out;
}

async function ingestOk(a: Hono, url: string, ip?: string): Promise<string> {
  const res = await post(a, '/api/ingest', { url }, ip);
  expect(res.status).toBe(200);
  const done = (await events(res, IngestEvent)).at(-1);
  if (done?.type !== 'done') throw new Error(JSON.stringify(done));
  return done.doc.docId;
}

/** A real, schema-valid answer produced by the mock provider, for chip runners to return. */
async function realAnswer(): Promise<AnswerResult> {
  const open = createApp(env.runtime, { localOnly: false });
  const docId = await ingestOk(open, 'https://govinfo.gov/a.txt');
  const res = await post(open, `/api/docs/${docId}/ask`, {
    question: 'What is this?',
  });
  const done = (await events(res, AskEvent)).at(-1);
  if (done?.type !== 'done') throw new Error('no answer');
  // Leave the library empty for the test itself.
  await open.request(`/api/docs/${docId}`, { method: 'DELETE' });
  return done.answer;
}

let chipRunner: ChipRunner;
beforeEach(async () => {
  const answer = await realAnswer();
  chipRunner = () =>
    Promise.resolve({
      answer,
      hits: [],
      backendUsage: {
        embedTokens: 0,
        rerankUnits: 0,
        readUnits: 0,
        writeUnits: 0,
      },
    });
});

describe('freeform questions', () => {
  test('are rejected with PUBLIC_MODE_FORBIDDEN, chips are allowed', async () => {
    const a = publicApp();
    const docId = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const free = await post(a, `/api/docs/${docId}/ask`, { question: 'hi' });
    expect(free.status).toBe(403);
    expect(await free.json()).toMatchObject({
      error: {
        code: 'PUBLIC_MODE_FORBIDDEN',
        message: 'That action is turned off on this public server.',
      },
    });
    env.runtime.chips = chipRunner;
    const chip = await post(a, `/api/docs/${docId}/ask`, { chipId: 'summary' });
    expect((await events(chip, AskEvent)).at(-1)?.type).toBe('done');
  });

  test('never generate a scenario, even for who-affected', async () => {
    const a = publicApp();
    const docId = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const provider = scenarioProvider(env.provider);
    Object.assign(env.runtime, { answerProvider: provider });
    const inner = chipRunner;
    env.runtime.chips = async (...args) => ({
      ...(await inner(...args)),
      hits: scenarioExcerpts(),
    });
    const res = await post(a, `/api/docs/${docId}/ask`, {
      chipId: 'who-affected',
    });
    const evs = await events(res, AskEvent);
    expect(evs.map((e) => e.type)).not.toContain('scenario');
    expect(provider.scenarioCalls).toBe(0);
  });

  test('a rejected freeform question does not use up the allowance', async () => {
    const a = publicApp({ limits: { questionsPerHour: 1 } });
    const docId = await ingestOk(a, 'https://govinfo.gov/a.txt');
    env.runtime.chips = chipRunner;
    for (let i = 0; i < 3; i++)
      await post(a, `/api/docs/${docId}/ask`, { question: 'hi' });
    const chip = await post(a, `/api/docs/${docId}/ask`, { chipId: 'summary' });
    expect(chip.status).toBe(200);
    await chip.text();
  });
});

describe('rate limits', () => {
  test('20 questions per hour per IP, then 429; other IPs and later hours are fine', async () => {
    let t = 0;
    const a = publicApp({ now: () => t });
    const docId = await ingestOk(a, 'https://govinfo.gov/a.txt');
    env.runtime.chips = chipRunner;
    const ask = async (ip: string) => {
      const res = await post(
        a,
        `/api/docs/${docId}/ask`,
        { chipId: 'summary' },
        ip,
      );
      const body = await res.text();
      return { status: res.status, body };
    };
    for (let i = 0; i < 20; i++)
      expect((await ask('9.9.9.9')).status).toBe(200);
    const limited = await ask('9.9.9.9');
    expect(limited.status).toBe(429);
    expect(JSON.parse(limited.body)).toMatchObject({
      error: { code: 'RATE_LIMITED' },
    });
    expect((await ask('8.8.8.8')).status).toBe(200);
    t = 60 * 60 * 1000 + 1;
    expect((await ask('9.9.9.9')).status).toBe(200);
  });

  test('3 ingests per hour per IP, then 429', async () => {
    const a = publicApp({ limits: { maxDocs: 50 } });
    for (let i = 0; i < 3; i++) {
      const res = await post(a, '/api/ingest', {
        url: 'https://govinfo.gov/a.txt',
      });
      await events(res, IngestEvent);
    }
    const limited = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/a.txt',
    });
    expect(limited.status).toBe(429);
    const other = await post(
      a,
      '/api/ingest',
      { url: 'https://govinfo.gov/a.txt' },
      '2.2.2.2',
    );
    expect(other.status).toBe(200);
    await other.text();
  });

  test('the default client address comes from X-Forwarded-For only when trusted', async () => {
    const send = (a: Hono, forwarded: string) =>
      a.request('/api/ingest', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': forwarded,
        },
        body: JSON.stringify({ url: 'https://govinfo.gov/a.txt' }),
      });
    const trusting = createApp(env.runtime, {
      publicMode: true,
      trustProxyHops: 1,
      limits: { ingestsPerHour: 1 },
    });
    await (await send(trusting, 'spoofed, 5.5.5.5')).text();
    expect((await send(trusting, 'different-spoof, 5.5.5.5')).status).toBe(429);
    expect((await send(trusting, '6.6.6.6')).status).toBe(200);
    // Untrusted: the header is ignored, so every caller shares one 'unknown' bucket.
    const plain = createApp(env.runtime, {
      publicMode: true,
      limits: { ingestsPerHour: 1 },
    });
    await (await send(plain, '5.5.5.5')).text();
    expect((await send(plain, '6.6.6.6')).status).toBe(429);
  });
});

/** The cap is decided once the document is known, so a refusal arrives as a stream error. */
async function expectCapRefusal(res: Response): Promise<void> {
  expect(res.status).toBe(200);
  expect((await events(res, IngestEvent)).at(-1)).toMatchObject({
    type: 'error',
    error: { code: 'DOC_CAP_REACHED' },
  });
}

describe('caps', () => {
  test('defaults the public cap to the configured document cap for admission and enforcement', async () => {
    env.runtime.maxDocs = 1;
    const a = publicApp();
    const eviction = vi.spyOn(env.registry, 'evictionCandidates');
    const first = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const res = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/b.xml',
    });
    await expectCapRefusal(res);
    // Refused at admission, before anything is stored or evicted.
    expect(eviction).toHaveBeenCalledTimes(1);
    expect((await env.registry.list()).map((e) => e.docId)).toEqual([first]);
  });

  test('an explicit public cap overrides the configured cap in the pipeline too', async () => {
    env.runtime.maxDocs = 1;
    const a = publicApp({ limits: { maxDocs: 2 } });
    const eviction = vi.spyOn(env.registry, 'evictionCandidates');
    const first = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const second = await ingestOk(a, 'https://govinfo.gov/b.xml');
    expect(eviction).toHaveBeenLastCalledWith(2, expect.any(Set));
    expect((await env.registry.list()).map((e) => e.docId).sort()).toEqual(
      [first, second].sort(),
    );
    // An address already in the store adds nothing, so it is allowed at the cap.
    const res = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/a.txt',
    });
    expect(res.status).toBe(200);
    expect(await events(res, IngestEvent)).toContainEqual(
      expect.objectContaining({ type: 'done' }),
    );
  });

  test('the global document cap refuses further ingests without evicting', async () => {
    const a = publicApp({ limits: { maxDocs: 1 } });
    const first = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const res = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/b.xml',
    });
    await expectCapRefusal(res);
    expect((await env.registry.list()).map((e) => e.docId)).toEqual([first]);
  });

  test('concurrent ingests count toward the cap, each document once', async () => {
    const a = publicApp({ limits: { maxDocs: 1 } });
    // Hold the first ingest right after it was admitted.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = env.backend.hasDocument.bind(env.backend);
    let held = false;
    vi.spyOn(env.backend, 'hasDocument').mockImplementation(async (id) => {
      if (!held) {
        held = true;
        await gate;
      }
      return real(id);
    });
    const running = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/a.txt',
    });
    await vi.waitFor(() => {
      expect(held).toBe(true);
    });
    await expectCapRefusal(
      await post(a, '/api/ingest', { url: 'https://govinfo.gov/b.xml' }),
    );
    release();
    expect((await events(running, IngestEvent)).at(-1)).toMatchObject({
      type: 'done',
    });
    // Once the first finished, its slot is a real document, so the cap still holds.
    await expectCapRefusal(
      await post(a, '/api/ingest', { url: 'https://govinfo.gov/b.xml' }),
    );
  });

  test('PDFs over 200 pages are refused with a plain message before indexing', async () => {
    const doc = (pageCount: number) =>
      Promise.resolve({
        docId: '',
        sourceUrl: 'https://govinfo.gov/x.pdf',
        format: 'pdf',
        fetchedAt: new Date(0).toISOString(),
        metadata: {
          title: null,
          billNumber: null,
          jurisdiction: null,
          session: null,
          version: null,
          sponsors: null,
          source: 'none',
        },
        sections: [],
        definitions: [],
        externalRefs: [],
        warnings: [],
        pageCount,
      } as NormalizedDoc);
    env.runtime.parsePdf = () => doc(201);
    env.serve(
      'https://govinfo.gov/big.pdf',
      { bytes: new Uint8Array([1, 2, 3]) },
      'application/pdf',
    );
    const a = publicApp();
    const evs = await events(
      await post(a, '/api/ingest', { url: 'https://govinfo.gov/big.pdf' }),
      IngestEvent,
    );
    expect(evs.at(-1)).toEqual({
      type: 'error',
      error: {
        code: 'TOO_LARGE',
        message: 'This public server accepts documents up to 200 pages.',
      },
    });
    expect(await env.registry.list()).toHaveLength(0);
  });

  test('a PDF at exactly the page cap is accepted by the page check', async () => {
    env.runtime.parsePdf = (bytes, context) =>
      Promise.resolve({
        docId: '',
        sourceUrl: context.sourceUrl,
        pageCount: 200,
      } as NormalizedDoc).then((d) => {
        throw new Error(
          `reached parser with ${String(bytes.length)} ${String(d.pageCount ?? 0)}`,
        );
      });
    env.serve(
      'https://govinfo.gov/ok.pdf',
      { bytes: new Uint8Array([1, 2, 3]) },
      'application/pdf',
    );
    const evs = await events(
      await post(publicApp(), '/api/ingest', {
        url: 'https://govinfo.gov/ok.pdf',
      }),
      IngestEvent,
    );
    // The stub parser throws its own (non-user) error, proving the cap did not trigger first.
    expect(evs.at(-1)).toMatchObject({ error: { code: 'PARSE_FAILED' } });
  });
});

describe('other public-mode rules', () => {
  test('a visitor removing a document only changes their own list', async () => {
    const a = publicApp();
    const docId = await ingestOk(a, 'https://govinfo.gov/a.txt');
    const res = await a.request(`/api/docs/${docId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await env.registry.list()).toHaveLength(1);
  });

  test('the Turnstile verifier gates ingest and ask and receives token and IP', async () => {
    const verifier = vi.fn((token: string | undefined) =>
      Promise.resolve(token === 'good'),
    );
    const a = publicApp({ turnstile: verifier });
    const denied = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/a.txt',
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({
      error: {
        message: 'The bot check failed. Reload the page and try again.',
      },
    });
    const ok = await post(
      a,
      '/api/ingest',
      {
        url: 'https://govinfo.gov/a.txt',
        turnstileToken: 'good',
      },
      '3.3.3.3',
    );
    expect(verifier).toHaveBeenLastCalledWith('good', '3.3.3.3');
    const done = (await events(ok, IngestEvent)).at(-1);
    if (done?.type !== 'done') throw new Error('expected done');
    env.runtime.chips = chipRunner;
    const askDenied = await post(a, `/api/docs/${done.doc.docId}/ask`, {
      chipId: 'summary',
    });
    expect(askDenied.status).toBe(403);
  });

  test('a failed bot check does not use up the rate limit', async () => {
    const a = publicApp({
      turnstile: (token) => Promise.resolve(token === 'good'),
      limits: { ingestsPerHour: 1 },
    });
    await post(a, '/api/ingest', { url: 'https://govinfo.gov/a.txt' });
    const ok = await post(a, '/api/ingest', {
      url: 'https://govinfo.gov/a.txt',
      turnstileToken: 'good',
    });
    expect(ok.status).toBe(200);
    await ok.text();
  });

  test('non-public mode applies none of these limits', async () => {
    const a = createApp(env.runtime, {
      limits: { ingestsPerHour: 1 },
      localOnly: false,
    });
    for (let i = 0; i < 3; i++) {
      const res = await post(a, '/api/ingest', {
        url: 'https://govinfo.gov/a.txt',
      });
      await events(res, IngestEvent);
    }
    expect((await env.registry.list()).length).toBe(1);
  });
});

test('trusted proxy hops count from the right and fall back for absent or short chains', async () => {
  const turnstile = vi.fn(() => Promise.resolve(false));
  const a = createApp(env.runtime, {
    publicMode: true,
    trustProxyHops: 2,
    turnstile,
  });
  for (const [forwarded, expected] of [
    ['spoofed, 1.2.3.4, 10.0.0.1', '1.2.3.4'],
    ['different-spoof, 1.2.3.4, 10.0.0.1', '1.2.3.4'],
    ['9.9.9.9', 'unknown'],
    ['', 'unknown'],
    [undefined, 'unknown'],
  ]) {
    await a.request('/api/ingest', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }),
      },
      body: JSON.stringify({ url: 'https://govinfo.gov/a.txt' }),
    });
    expect(turnstile).toHaveBeenLastCalledWith(undefined, expected);
  }
});
