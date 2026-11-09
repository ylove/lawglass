/** Hosting hooks part B (ADR 0018): quotes, admission, usage context, budgets, model routing. */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Context, Hono } from 'hono';
import {
  breakdownProvider,
  type BreakdownProvider,
} from '../../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import {
  scenarioProvider,
  type ScenarioProvider,
} from '../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import type { UsageEvent } from '../core/cost/index.js';
import {
  IngestEvent,
  SummaryResponse,
  type LlmProvider,
} from '../core/model/index.js';
import { MockProvider } from '../core/llm/mock.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';
import type { Admission, AdmissionJob } from './admission.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
let provider: BreakdownProvider & { scen: ScenarioProvider };
let logs: string[];

const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Sign in', 401),
  readerId: (c) => c.req.header('x-reader') ?? 'nobody',
};

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(url, makeSectionedText(), 'text/plain');
  const scen = scenarioProvider(env.provider);
  provider = Object.assign(breakdownProvider(scen), { scen });
  Object.assign(env.runtime, { answerProvider: provider });
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
  logs = [];
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
  picked: RATE,
  'tier-a': RATE,
  'tier-b': RATE,
  'extract-model': RATE,
};
const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    logWriter: (line) => logs.push(line),
    summaryWaitMs: 20,
    ...options,
    quote: { prices: PRICES, ...options.quote },
  });
const call = (
  a: Hono,
  path: string,
  init: { method?: string; body?: unknown; reader?: string } = {},
) =>
  a.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-reader': init.reader ?? 'alice',
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
async function ingestDoc(
  a: Hono,
  reader = 'alice',
  body: Record<string, unknown> = {},
): Promise<string> {
  const res = await call(a, '/api/ingest', {
    reader,
    body: { url, ...body },
  });
  expect(res.status).toBe(200);
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

/** Counts every model call on both providers. */
function modelCalls(): () => number {
  const spies = [
    vi.spyOn(provider, 'generateObject'),
    vi.spyOn(provider, 'streamText'),
    vi.spyOn(env.provider, 'generateObject'),
    vi.spyOn(env.provider, 'streamText'),
  ];
  return () => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
}

const allow: Admission = { allow: true };
const deny = (status: 402 | 403 | 429): Admission =>
  status === 402
    ? { allow: false, status, quote: { quoteId: 'host-q', display: '$1.00' } }
    : {
        allow: false,
        status,
        error: { code: 'NO_BALANCE', message: 'Add funds first.' },
      };

describe('POST /api/quote', () => {
  test('fetches and parses only: no model, no embedding, nothing stored', async () => {
    const calls = modelCalls();
    const embed = vi.spyOn(env.embedder, 'embed');
    const upsert = vi.spyOn(env.backend, 'upsertChunks');
    const a = app();
    const res = await call(a, '/api/quote', { body: { url } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      quoteId: string;
      facts: Record<string, unknown>;
      estimates: Record<string, { models: unknown; total: unknown }>;
    };
    expect(body.quoteId).toMatch(/^[\w-]{20,}$/);
    expect(body.facts).toEqual({
      pages: null,
      sections: expect.any(Number) as number,
      tokens: expect.any(Number) as number,
      mode: 'whole',
      units: expect.any(Number) as number,
    });
    expect(Object.keys(body.estimates)).toEqual(['default']);
    expect(body.estimates.default?.total).toBeDefined();
    expect(calls()).toBe(0);
    expect(embed).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(await env.registry.list()).toEqual([]);
    // Two requests make two distinct opaque ids.
    const again = (await (
      await call(a, '/api/quote', { body: { url } })
    ).json()) as {
      quoteId: string;
    };
    expect(again.quoteId).not.toBe(body.quoteId);
  });

  test('estimates each configured tier', async () => {
    const a = app({
      quote: {
        tiers: {
          fast: {
            answerModel: 'claude-haiku-5-5',
            extractModel: 'claude-haiku-5-5',
          },
          best: {
            answerModel: 'claude-opus-5-5',
            extractModel: 'claude-haiku-5-5',
          },
        },
      },
    });
    const body = (await (
      await call(a, '/api/quote', { body: { url } })
    ).json()) as {
      estimates: Record<string, { models: { answerModel: string } }>;
    };
    expect(Object.keys(body.estimates)).toEqual(['fast', 'best']);
    expect(body.estimates.best?.models.answerModel).toBe('claude-opus-5-5');
  });

  test('applies the ingest host allowlist, protocol and body limits', async () => {
    const a = app();
    expect(
      (await call(a, '/api/quote', { body: { url: 'https://evil.example/x' } }))
        .status,
    ).toBe(400);
    expect(
      (await call(a, '/api/quote', { body: { url: 'file:///etc/passwd' } }))
        .status,
    ).toBe(400);
    expect((await call(a, '/api/quote', { body: { nope: 1 } })).status).toBe(
      400,
    );
    const big = await a.request('/api/quote', {
      method: 'POST',
      headers: { 'x-reader': 'alice', 'content-type': 'application/json' },
      body: JSON.stringify({ url, pad: 'x'.repeat(20_000) }),
    });
    expect(big.status).toBe(413);
  });

  test('is rate limited per address in hosted modes', async () => {
    const a = app({ quote: { perHour: 2 }, clientIp: () => '1.2.3.4' });
    expect((await call(a, '/api/quote', { body: { url } })).status).toBe(200);
    expect((await call(a, '/api/quote', { body: { url } })).status).toBe(200);
    expect((await call(a, '/api/quote', { body: { url } })).status).toBe(429);
  });

  test('is refused in public mode unless the host enables it', async () => {
    const publicApp = (quote?: AppOptions['quote']) =>
      createApp(env.runtime, {
        publicMode: true,
        localOnly: false,
        logWriter: () => undefined,
        ...(quote ? { quote } : {}),
      });
    const post = (a: Hono) =>
      a.request('/api/quote', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
    expect((await post(publicApp())).status).toBe(403);
    expect(
      (await post(publicApp({ allowInPublicMode: true, prices: PRICES })))
        .status,
    ).toBe(200);
  });

  test('the quote id reaches admission on ingest only while live and for the same reader and address', async () => {
    let now = 1_000_000;
    const seen: (string | undefined)[] = [];
    const a = app({
      now: () => now,
      admission: (_c, job) => {
        seen.push(job.quoteId);
        return Promise.resolve(allow);
      },
    });
    const quote = async (reader = 'alice') =>
      (
        (await (
          await call(a, '/api/quote', { reader, body: { url } })
        ).json()) as {
          quoteId: string;
        }
      ).quoteId;
    const q1 = await quote();
    await ingestDoc(a, 'alice', { quoteId: q1 });
    expect(seen.at(-1)).toBe(q1);
    // Another reader cannot use it; neither can anyone after the 30 minute TTL.
    await ingestDoc(a, 'bob', { quoteId: q1 });
    expect(seen.at(-1)).toBeUndefined();
    now += 31 * 60_000;
    await ingestDoc(a, 'alice', { quoteId: q1 });
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe('admission', () => {
  test('without hooks nothing changes and no estimate is computed', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/ask`, {
      body: { chipId: 'summary' },
    });
    expect(res.status).toBe(200);
  });

  test('ingest: sees a whole-bill estimate before any model call, for new and reused documents', async () => {
    const jobs: AdmissionJob[] = [];
    const atAdmission: number[] = [];
    const calls = modelCalls();
    const a = app({
      admission: (_c, job) => {
        jobs.push(job);
        atAdmission.push(calls());
        return Promise.resolve(allow);
      },
    });
    const docId = await ingestDoc(a);
    const afterFirst = calls();
    await ingestDoc(a, 'bob'); // reused
    expect(atAdmission).toEqual([0, afterFirst]);
    expect(jobs.map((j) => [j.kind, j.docId])).toEqual([
      ['ingest', docId],
      ['ingest', docId],
    ]);
    expect(jobs[0]?.estimate).toHaveProperty('features');
    expect(Object.keys(jobs[0]?.estimates ?? {})).toEqual(['default']);
  });

  test.each([402, 403, 429] as const)(
    'ingest refused with %s makes no model call and sends no stream',
    async (status) => {
      const calls = modelCalls();
      const a = app({ admission: () => Promise.resolve(deny(status)) });
      const res = await call(a, '/api/ingest', { body: { url } });
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(calls()).toBe(0);
      expect(await env.registry.list()).toEqual([]);
      const body = (await res.json()) as Record<string, unknown>;
      if (status === 402)
        expect(body).toEqual({
          error: {
            code: 'PAYMENT_REQUIRED',
            message: expect.any(String) as string,
          },
          quote: { quoteId: 'host-q', display: '$1.00' },
        });
      else
        expect(body).toEqual({
          error: { code: 'NO_BALANCE', message: 'Add funds first.' },
        });
    },
  );

  test('questions: a model chip and a typed question are admitted; a metadata chip is exempt', async () => {
    const jobs: AdmissionJob[] = [];
    const a = app({
      admission: (_c, job) => {
        jobs.push(job);
        return Promise.resolve(allow);
      },
    });
    const docId = await ingestDoc(a);
    jobs.length = 0;
    const ask = (body: object) => call(a, `/api/docs/${docId}/ask`, { body });
    await (await ask({ chipId: 'summary' })).text();
    await (await ask({ question: 'Who pays?' })).text();
    await (await ask({ chipId: 'sponsor' })).text();
    expect(jobs.map((j) => [j.kind, j.chipId, j.docId])).toEqual([
      ['question', 'summary', docId],
      ['question', undefined, docId],
    ]);
    expect(jobs[0]?.estimate).toHaveProperty('high');
  });

  test('questions: refusal comes before the stream and before any model call', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const calls = modelCalls();
    const denied = app({ admission: () => Promise.resolve(deny(402)) });
    const res = await call(denied, `/api/docs/${docId}/ask`, {
      body: { chipId: 'summary' },
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(calls()).toBe(0);
  });

  test('locate, scenario and a generating example are admitted; a cached example is not', async () => {
    const jobs: AdmissionJob[] = [];
    const plain = app();
    const docId = await ingestDoc(plain);
    await call(plain, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(async () => {
      const r = (await (
        await call(plain, `/api/docs/${docId}/breakdown`)
      ).json()) as {
        status: string;
      };
      expect(r.status).toBe('cached');
    });
    const a = app({
      admission: (_c, job) => {
        jobs.push(job);
        return Promise.resolve(allow);
      },
    });
    await call(a, `/api/docs/${docId}/locate`, {
      body: { text: 'The department shall publish a rule.' },
    });
    await call(a, `/api/docs/${docId}/scenario`, {
      body: { subject: 'a farmer' },
    });
    const path = `/api/docs/${docId}/sections/sec-2/example`;
    await call(a, path);
    await vi.waitFor(async () => {
      const r = (await (await call(a, path)).json()) as { status: string };
      expect(r.status).toBe('ok');
    });
    const admissions = jobs.length;
    await call(a, path);
    await call(a, path);
    expect(jobs.map((j) => j.kind)).toEqual(['locate', 'scenario', 'example']);
    expect(jobs.length).toBe(admissions);
  });

  test('locate, scenario and example refusals make no model call', async () => {
    const plain = app();
    const docId = await ingestDoc(plain);
    const calls = modelCalls();
    const a = app({ admission: () => Promise.resolve(deny(429)) });
    const locate = await call(a, `/api/docs/${docId}/locate`, {
      body: { text: 'The department shall publish a rule.' },
    });
    const scenario = await call(a, `/api/docs/${docId}/scenario`, {
      body: { subject: 'a farmer' },
    });
    const example = await call(a, `/api/docs/${docId}/sections/sec-2/example`);
    expect([locate.status, scenario.status, example.status]).toEqual([
      429, 429, 429,
    ]);
    expect(calls()).toBe(0);
  });

  test('a host that returns nonsense, or an invalid budget, fails closed', async () => {
    const calls = modelCalls();
    const nonsense = app({
      admission: () => Promise.resolve(undefined as unknown as Admission),
    });
    expect(
      (await call(nonsense, '/api/ingest', { body: { url } })).status,
    ).toBe(403);
    const badBudget = app({
      admission: () =>
        Promise.resolve({ allow: true, budget: { dollars: -1 } } as Admission),
    });
    expect(
      (await call(badBudget, '/api/ingest', { body: { url } })).status,
    ).toBe(500);
    expect(calls()).toBe(0);
  });

  test('the host sees the request context', async () => {
    let reader = '';
    const a = app({
      admission: (c: Context) => {
        reader = c.req.header('x-reader') ?? '';
        return Promise.resolve(allow);
      },
    });
    await ingestDoc(a, 'carol');
    expect(reader).toBe('carol');
  });
});

describe('usage with job context', () => {
  test('foreground work carries the admitted reader, kind and doc', async () => {
    const events: UsageEvent[] = [];
    const a = app({
      onUsage: (event) => {
        events.push(event);
      },
    });
    const docId = await ingestDoc(a);
    await (
      await call(a, `/api/docs/${docId}/ask`, {
        body: { question: 'Who pays?' },
      })
    ).text();
    const question = events.filter((e) => e.job?.jobKind === 'question');
    expect(question.length).toBeGreaterThan(0);
    expect(question[0]?.job).toMatchObject({ readerId: 'alice', docId });
    expect(new Set(question.map((e) => e.job?.jobId)).size).toBe(1);
  });

  test('background generation keeps the first admitted ingest context, whoever opens the document', async () => {
    const events: UsageEvent[] = [];
    const a = app({
      admission: () => Promise.resolve(allow),
      onUsage: (event) => {
        events.push(event);
      },
    });
    const docId = await ingestDoc(a, 'alice');
    await ingestDoc(a, 'bob'); // a second admitted ingest does not take over
    // Bob opens the summary, the breakdown and the pictures; alice's job pays.
    const summary = () =>
      call(a, `/api/docs/${docId}/summary`, { reader: 'bob' });
    await summary();
    await vi.waitFor(async () => {
      const r = SummaryResponse.parse(await (await summary()).json());
      expect(r.status).toBe('cached');
    });
    await call(a, `/api/docs/${docId}/breakdown`, { reader: 'bob' });
    await vi.waitFor(() => {
      expect(events.some((e) => e.feature === 'breakdown')).toBe(true);
    });
    const ingestJob = events.find((e) => e.feature === 'metadata')?.job;
    expect(ingestJob).toMatchObject({ readerId: 'alice', jobKind: 'ingest' });
    for (const feature of ['summary', 'breakdown'] as const) {
      const hit = events.filter((e) => e.feature === feature);
      expect(hit.length).toBeGreaterThan(0);
      for (const e of hit) expect(e.job).toEqual({ ...ingestJob, docId });
    }
  });
});

describe('budgets', () => {
  test('a document whose generation budget is spent stops, logs once, and makes no further model call', async () => {
    // Every call reports usage, so the ingest's metadata call alone spends the 100 token budget.
    for (const p of [env.provider, provider]) {
      const original = p.generateObject.bind(p);
      vi.spyOn(p, 'generateObject').mockImplementation(async (req) => ({
        ...(await original(req)),
        usage: { inputTokens: 100, outputTokens: 50 },
      }));
    }
    const events: UsageEvent[] = [];
    const a = app({
      admission: () =>
        Promise.resolve({ allow: true, budget: { tokens: 100 } }),
      onUsage: (e) => {
        events.push(e);
      },
    });
    const docId = await ingestDoc(a);
    expect(events.map((e) => e.feature)).toContain('metadata');
    const stream = vi.spyOn(provider, 'streamText');
    const summary = () => call(a, `/api/docs/${docId}/summary`);
    await summary();
    await vi.waitFor(async () => {
      const r = SummaryResponse.parse(await (await summary()).json());
      expect(r.status).toBe('disabled');
    });
    expect(stream).not.toHaveBeenCalled();
    const exhausted = logs.filter((l) => l.includes('budget_exhausted'));
    expect(exhausted).toHaveLength(1);
    // Counts only: no document id, text or URL.
    expect(
      Object.keys(JSON.parse(exhausted[0] ?? '{}') as object).sort(),
    ).toEqual(
      ['count', 'event', 'jobKind', 'level', 'ms', 't', 'status'].sort(),
    );
  });

  test('a question has its own budget, apart from the document generation budget', async () => {
    const a = app({
      admission: (_c, job) =>
        Promise.resolve(
          job.kind === 'ingest'
            ? { allow: true, budget: { tokens: 1 } }
            : allow,
        ),
    });
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/ask`, {
      body: { question: 'Who pays?' },
    });
    expect(await res.text()).toContain('"type":"done"');
  });
});

describe('background scope after a restart', () => {
  const summaryOf = async (a: Hono, docId: string) =>
    SummaryResponse.parse(
      await (await call(a, `/api/docs/${docId}/summary`)).json(),
    );
  /** A document ingested by an earlier process; nothing is cached for it. */
  const earlierProcess = () => ingestDoc(app());
  const restarted = (options: AppOptions) => app(options);

  test('restores the persisted tier, job id and usage context; consulted once while live', async () => {
    const docId = await earlierProcess();
    const events: UsageEvent[] = [];
    const used: string[] = [];
    env.runtime.providerFor = (_role, model) => {
      used.push(model ?? '');
      return new MockProvider(model);
    };
    const lookup = vi.fn(() =>
      Promise.resolve({
        models: { answer: 'tier-a' },
        jobId: 'persisted-job',
        budget: { tokens: 1_000_000 },
      }),
    );
    const a = restarted({
      admission: () => Promise.resolve(allow),
      backgroundScope: lookup,
      onUsage: (e) => {
        events.push(e);
      },
    });
    await summaryOf(a, docId);
    await vi.waitFor(async () => {
      expect((await summaryOf(a, docId)).status).toBe('cached');
    });
    expect(used).toContain('tier-a');
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith(docId);
    const summary = events.filter((e) => e.feature === 'summary');
    for (const e of summary) expect(e.job?.jobId).toBe('persisted-job');
  });

  test('enforces the persisted budget', async () => {
    const docId = await earlierProcess();
    const original = provider.streamText.bind(provider);
    vi.spyOn(provider, 'streamText').mockImplementation((req) =>
      (async function* () {
        for await (const e of original(req))
          yield e.type === 'done'
            ? { ...e, usage: { inputTokens: 100, outputTokens: 50 } }
            : e;
      })(),
    );
    const a = restarted({
      admission: () => Promise.resolve(allow),
      backgroundScope: () => Promise.resolve({ budget: { tokens: 1 } }),
    });
    await summaryOf(a, docId);
    await vi.waitFor(async () => {
      expect((await summaryOf(a, docId)).status).toBe('cached');
    });
    // The summary spent the whole budget, so the breakdown is refused before any model call.
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(() => {
      expect(logs.some((l) => l.includes('budget_exhausted'))).toBe(true);
    });
    expect(provider.breakdownCalls).toBe(0);
  });

  test('an unknown document with admission configured is served from cache only', async () => {
    const docId = await earlierProcess();
    const stream = vi.spyOn(provider, 'streamText');
    const a = restarted({
      admission: () => Promise.resolve(allow),
      backgroundScope: () => Promise.resolve(undefined),
    });
    await summaryOf(a, docId);
    await vi.waitFor(async () => {
      expect((await summaryOf(a, docId)).status).toBe('disabled');
    });
    expect(stream).not.toHaveBeenCalled();
    expect(provider.breakdownCalls).toBe(0);
    // Cached results are still served.
    const plain = app();
    await summaryOf(plain, docId);
    await vi.waitFor(async () => {
      expect((await summaryOf(plain, docId)).status).toBe('cached');
    });
    expect((await summaryOf(a, docId)).status).toBe('cached');
  });

  test("without the hook, or without admission, today's behaviour is kept", async () => {
    const docId = await earlierProcess();
    const a = restarted({ backgroundScope: () => Promise.resolve(undefined) });
    await summaryOf(a, docId);
    await vi.waitFor(async () => {
      expect((await summaryOf(a, docId)).status).toBe('cached');
    });
  });
});

describe('model routing', () => {
  test('modelFor picks the models for a job and two tiers never share cached text', async () => {
    const built: string[] = [];
    const perModel = new Map<string, MockProvider>();
    env.runtime.providerFor = (_role, model) => {
      built.push(model ?? '');
      let p = perModel.get(model ?? '');
      if (!p) {
        p = new MockProvider(model);
        perModel.set(model ?? '', p);
      }
      return p;
    };
    const tier = (name: string) =>
      app({ modelFor: () => ({ answer: name, extract: 'extract-model' }) });
    const first = tier('tier-a');
    const docId = await ingestDoc(first);
    const summaryOf = async (a: Hono) =>
      SummaryResponse.parse(
        await (await call(a, `/api/docs/${docId}/summary`)).json(),
      );
    await summaryOf(first);
    await vi.waitFor(async () => {
      expect((await summaryOf(first)).status).toBe('cached');
    });
    expect(built).toContain('tier-a');
    // Another tier of the same bill (a second app has its own tier) starts from scratch.
    const second = tier('tier-b');
    await ingestDoc(second);
    expect((await summaryOf(second)).status).toBe('pending');
    await vi.waitFor(async () => {
      expect((await summaryOf(second)).status).toBe('cached');
    });
    expect(built).toContain('tier-b');
  });

  test('a question uses the model the host chose for that job', async () => {
    const models: string[] = [];
    const answerFrom = new MockProvider('picked');
    vi.spyOn(answerFrom, 'streamText').mockImplementation(function (req) {
      models.push(answerFrom.model);
      return MockProvider.prototype.streamText.call(answerFrom, req);
    });
    env.runtime.providerFor = () => answerFrom;
    const a = app({
      modelFor: (job) => (job.kind === 'question' ? { answer: 'picked' } : {}),
    });
    const docId = await ingestDoc(a);
    await (
      await call(a, `/api/docs/${docId}/ask`, {
        body: { question: 'Who pays?' },
      })
    ).text();
    expect(models.length).toBeGreaterThan(0);
  });
});

describe('hook validation', () => {
  test.each(['admission', 'onUsage', 'modelFor', 'backgroundScope'] as const)(
    '%s must be a function',
    (name) => {
      expect(() => app({ [name]: 'nope' })).toThrow(
        `${name} must be a function`,
      );
    },
  );
});

export type { LlmProvider };
