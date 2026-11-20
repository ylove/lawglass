/** Answer modes, output caps and the question quote (issue #429). */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hono } from 'hono';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import type { FeatureEstimate } from '../core/cost/index.js';
import { IngestEvent } from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';
import type { AdmissionJob } from './admission.js';
import type { QuestionQuote, QuestionQuoteRequest } from './question-quote.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;

const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Sign in', 401),
  readerId: (c) => c.req.header('x-reader') ?? 'nobody',
};

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(url, makeSectionedText(), 'text/plain');
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSharedLimits();
  await env.cleanup();
});

const RATE = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };
const PRICES = {
  deterministic: RATE,
  'claude-haiku-5-5': RATE,
};
const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    logWriter: () => undefined,
    summaryWaitMs: 20,
    ...options,
    quote: { prices: PRICES, ...options.quote },
  });
const call = (a: Hono, path: string, body?: unknown, reader = 'alice') =>
  a.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-reader': reader, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function ingestDoc(a: Hono): Promise<string> {
  const res = await call(a, '/api/ingest', { url });
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

describe('POST /api/docs/:docId/question-quote', () => {
  test('without a hook it answers null and never prices anything', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quote: null });
  });

  test('passes the hook the document, reader, tier and worst cases, and returns its quote', async () => {
    const seen: QuestionQuoteRequest[] = [];
    const quote: QuestionQuote = {
      whole: { units: 4 },
      focused: { units: 1 },
      remaining: 30,
      unit: 'questions',
    };
    const a = app({
      questionQuote: (req) => {
        seen.push(req);
        return Promise.resolve(quote);
      },
      answerLimits: { focusedMaxTokens: 4096 },
    });
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(await res.json()).toEqual({ quote });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ docId, reader: 'alice' });
    expect(seen[0]?.tier).toBeUndefined();
    const { worstCase } = seen[0]!;
    expect(worstCase.whole!.dollars).toBeGreaterThan(worstCase.focused.dollars);
    // The focused cap the server runs under is the one that was priced.
    expect(worstCase.focused.outputTokens).toBe(2 * 4096);
  });

  test('names the tier modelFor chose', async () => {
    const seen: QuestionQuoteRequest[] = [];
    const a = app({
      modelFor: () => ({ answer: 'claude-haiku-5-5' }),
      admission: () => Promise.resolve({ allow: true }),
      backgroundScope: () => Promise.resolve(undefined),
      questionQuote: (req) => {
        seen.push(req);
        return Promise.resolve({ focused: { units: 1 } });
      },
    });
    const docId = await ingestDoc(a);
    await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(seen[0]?.tier).toBe('claude-haiku-5-5+default');
    expect(seen[0]?.worstCase.model).toBe('claude-haiku-5-5');
  });

  test('a hook with nothing to say gives null', async () => {
    const a = app({ questionQuote: () => Promise.resolve(undefined) });
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(await res.json()).toEqual({ quote: null });
  });

  test('a malformed hook answer is a server error, never shown to the reader', async () => {
    const a = app({
      questionQuote: () =>
        Promise.resolve({ focused: { units: -1 } } as QuestionQuote),
    });
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(res.status).toBe(500);
  });

  test('an unknown document is a 404 and the hook is not asked', async () => {
    const hook = vi.fn(() => Promise.resolve(undefined));
    const a = app({ questionQuote: hook });
    const res = await call(a, `/api/docs/${'f'.repeat(64)}/question-quote`, {});
    expect(res.status).toBe(404);
    expect(hook).not.toHaveBeenCalled();
  });

  test('canRead guards it like every document route', async () => {
    const hook = vi.fn(() => Promise.resolve(undefined));
    const a = app({ questionQuote: hook, canRead: () => false });
    const res = await call(a, `/api/docs/${'f'.repeat(64)}/question-quote`, {});
    expect(res.status).toBe(404);
    expect(hook).not.toHaveBeenCalled();
  });

  test('a read-only reader has nothing to buy: null, hook not asked', async () => {
    const hook = vi.fn(() => Promise.resolve({ focused: { units: 1 } }));
    const a = app({ questionQuote: hook, readOnly: () => true });
    const docId = await ingestDoc(createApp(env.runtime, { auth }));
    const res = await call(a, `/api/docs/${docId}/question-quote`, {});
    expect(await res.json()).toEqual({ quote: null });
    expect(hook).not.toHaveBeenCalled();
  });
});

describe('ask mode', () => {
  const ask = (a: Hono, docId: string, body: object) =>
    call(a, `/api/docs/${docId}/ask`, { question: 'Who pays?', ...body });

  test('auto and absent read the whole bill at the old caps', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const spy = vi.spyOn(env.provider, 'streamText');
    await (await ask(a, docId, {})).text();
    await (await ask(a, docId, { mode: 'auto' })).text();
    const [first, second] = spy.mock.calls.map(([req]) => req);
    expect(first).toMatchObject({ maxTokens: 16_000, effort: 'medium' });
    expect(second).toMatchObject({ maxTokens: 16_000, effort: 'medium' });
  });

  test('focused retrieves excerpts and runs at the focused cap', async () => {
    const a = app({ answerLimits: { focusedMaxTokens: 4096 } });
    const docId = await ingestDoc(a);
    const spy = vi.spyOn(env.provider, 'streamText');
    const text = await (await ask(a, docId, { mode: 'focused' })).text();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({
      maxTokens: 4096,
      effort: 'low',
    });
    expect(text).toContain('"context":"excerpts"');
    expect(text).not.toContain('"mode":"whole"');
  });

  test('whole runs at the whole cap', async () => {
    const a = app({ answerLimits: { wholeMaxTokens: 9000 } });
    const docId = await ingestDoc(a);
    const spy = vi.spyOn(env.provider, 'streamText');
    const text = await (await ask(a, docId, { mode: 'whole' })).text();
    expect(spy.mock.calls[0]?.[0]).toMatchObject({ maxTokens: 9000 });
    expect(text).toContain('"context":"whole"');
  });

  test('an unknown mode is refused as invalid input', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await ask(a, docId, { mode: 'cheap' });
    expect(res.status).toBe(400);
  });

  test('a chip ignores mode', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/ask`, {
      chipId: 'who-affected',
      mode: 'focused',
    });
    expect(res.status).toBe(200);
    await res.text();
  });

  test('admission sees the forecast read and an estimate that follows it', async () => {
    const jobs: AdmissionJob[] = [];
    const a = app({
      admission: (_c, job) => {
        jobs.push(job);
        return Promise.resolve({ allow: true });
      },
      backgroundScope: () => Promise.resolve(undefined),
      answerLimits: { focusedMaxTokens: 4096 },
    });
    const docId = await ingestDoc(a);
    jobs.length = 0;
    for (const mode of [undefined, 'whole', 'focused'])
      await (await ask(a, docId, mode === undefined ? {} : { mode })).text();
    const [auto, whole, focused] = jobs;
    expect(auto).toMatchObject({ kind: 'question', mode: 'whole' });
    expect(whole).toMatchObject({ mode: 'whole' });
    expect(focused).toMatchObject({ mode: 'focused' });
    const high = (job?: AdmissionJob) =>
      (job?.estimate as FeatureEstimate).high.dollars;
    expect(high(focused)).toBeLessThan(high(auto));
    expect(whole!.estimate).toEqual(auto!.estimate);
  });

  test('a chip is admitted without a mode', async () => {
    const jobs: AdmissionJob[] = [];
    const a = app({
      admission: (_c, job) => {
        jobs.push(job);
        return Promise.resolve({ allow: true });
      },
      backgroundScope: () => Promise.resolve(undefined),
    });
    const docId = await ingestDoc(a);
    jobs.length = 0;
    await (
      await call(a, `/api/docs/${docId}/ask`, { chipId: 'who-affected' })
    ).text();
    expect(jobs[0]?.mode).toBeUndefined();
  });
});

describe('answerLimits', () => {
  test('a cap below the floor is refused at startup', () => {
    expect(() => app({ answerLimits: { focusedMaxTokens: 10 } })).toThrow(
      RangeError,
    );
  });
});
