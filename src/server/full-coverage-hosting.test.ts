/**
 * Full coverage under the hosting hooks (#382 with ADR 0018 part B): the money invariants must
 * hold for the long background paths too. Every model call is admitted, charged to the live
 * (document, tier) scope and reported through `onUsage`; a refused reader causes none.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hono } from 'hono';
import {
  breakdownProvider,
  type BreakdownProvider,
} from '../../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { scenarioProvider } from '../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import type { UsageEvent } from '../core/cost/index.js';
import { currentJob } from '../core/cost/job.js';
import { MockProvider } from '../core/llm/mock.js';
import {
  AppError,
  IngestEvent,
  type LlmProvider,
} from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import type { Admission, AdmissionJob } from './admission.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';

const big = 'https://govinfo.gov/big.txt';
const FULL = {
  breakdownMaxUnits: 'all' as const,
  pregenerateExamples: 'all' as const,
};
const RATE = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };

let env: PipelineEnv;
let answers: BreakdownProvider;
let modelCalls: number;

const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Sign in', 401),
  readerId: (c) => c.req.header('x-reader') ?? 'nobody',
};

/** Counts every call a provider is asked to make, wherever it is asked from. */
function counting(p: LlmProvider): LlmProvider {
  return {
    get id() {
      return p.id;
    },
    get model() {
      return p.model;
    },
    streamText: (req) => {
      modelCalls++;
      return p.streamText(req);
    },
    generateObject: (req) => {
      modelCalls++;
      return p.generateObject(req);
    },
  };
}

function bill(count: number, tag: string): { bytes: Uint8Array } {
  const lines = [`Synthetic Many Parts Bill ${tag}`];
  for (let i = 1; i <= count; i++)
    lines.push(
      `SECTION ${String(i)}. Heading ${String(i)}`,
      `The department shall do thing number ${String(i)} for every garden group in the state.`,
    );
  return { bytes: new TextEncoder().encode(`${lines.join('\n')}\n`) };
}

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(big, makeSectionedText(), 'text/plain');
  answers = breakdownProvider(scenarioProvider(env.provider));
  Object.assign(env.runtime, {
    answerProvider: counting(answers),
    extractProvider: counting(env.provider),
    providerFor: (_role: string, model?: string) =>
      counting(breakdownProvider(scenarioProvider(new MockProvider(model)))),
  });
  modelCalls = 0;
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '10000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSharedLimits();
  await env.cleanup();
});

const app = (options: AppOptions): Hono =>
  createApp(env.runtime, {
    auth,
    summaryWaitMs: 20,
    logWriter: () => undefined,
    ...options,
    quote: {
      prices: { deterministic: RATE, 'tier-a': RATE, 'tier-b': RATE },
      ...options.quote,
    },
  });

const call = (
  a: Hono,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    reader?: string;
  } = {},
) =>
  a.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-reader': init.reader ?? 'alice',
      'content-type': 'application/json',
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

async function ingestDoc(a: Hono, reader = 'alice'): Promise<string> {
  const res = await call(a, '/api/ingest', { reader, body: { url: big } });
  expect(res.status).toBe(200);
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const unknown = () => Promise.resolve(undefined);
const allow = (): Promise<Admission> =>
  Promise.resolve({ allow: true, budget: { tokens: 1_000_000_000 } });

interface BreakdownBody {
  status: string;
  briefs?: unknown[];
  stoppedReason?: string;
  progress?: { stoppedReason?: string };
}
async function breakdownOf(a: Hono, docId: string, reader = 'alice') {
  return (await (
    await call(a, `/api/docs/${docId}/breakdown`, { reader })
  ).json()) as BreakdownBody;
}
async function picturesOf(a: Hono, docId: string, reader = 'alice') {
  return (await (
    await call(a, `/api/docs/${docId}/breakdown/pictures`, { reader })
  ).json()) as { status: string; entries?: unknown[] };
}
const stopped = (s: BreakdownBody) =>
  s.stoppedReason ?? s.progress?.stoppedReason;
const tokens = (us: readonly UsageEvent[]) =>
  us.reduce((n, u) => n + u.usage.inputTokens + u.usage.outputTokens, 0);

/** Pictures report real usage (100 tokens a call), so they count against a budget. */
function paidPictures(): void {
  const orig = env.provider.generateObject.bind(env.provider);
  vi.spyOn(env.provider, 'generateObject').mockImplementation(async (req) => {
    const r = await orig(req);
    return req.schemaName === 'pictures'
      ? { ...r, usage: { inputTokens: 60, outputTokens: 40 } }
      : r;
  });
}

/** A bill briefed earlier whose pictures failed, so they are still to be drawn. */
async function briefedWithoutPictures(count: number, tag: string) {
  env.serve(big, bill(count, tag), 'text/plain');
  const orig = env.provider.generateObject.bind(env.provider);
  const spy = vi
    .spyOn(env.provider, 'generateObject')
    .mockImplementation((req) =>
      req.schemaName === 'pictures'
        ? Promise.reject(new AppError('PROVIDER_ERROR'))
        : orig(req),
    );
  const plain = app({ ...FULL, pregenerateExamples: 'off' });
  const docId = await ingestDoc(plain);
  await call(plain, `/api/docs/${docId}/breakdown`);
  await vi.waitFor(
    async () => {
      expect((await breakdownOf(plain, docId)).status).toBe('cached');
    },
    { timeout: 10_000 },
  );
  await settle(600);
  spy.mockRestore();
  return docId;
}

describe('a refused reader costs nothing under full coverage', () => {
  test('refused ingest of a bill with undrawn pictures makes no model call', async () => {
    const docId = await briefedWithoutPictures(25, 'f1');
    expect(docId).toBeTruthy();
    modelCalls = 0;
    const usage: UsageEvent[] = [];
    const jobs: AdmissionJob[] = [];
    const denied = app({
      ...FULL,
      admission: (_c, job) => {
        jobs.push(job);
        return Promise.resolve({
          allow: false,
          status: 403,
          error: { code: 'NO_BALANCE', message: 'Add funds first.' },
        });
      },
      backgroundScope: unknown,
      onUsage: (e) => void usage.push(e),
    });
    const r = await call(denied, '/api/ingest', {
      reader: 'mallory',
      body: { url: big },
    });
    await r.text();
    await settle(1200);
    expect(r.status).toBe(403);
    expect(modelCalls).toBe(0);
    expect(usage).toEqual([]);
  });
});

describe('a top-up under full coverage', () => {
  const budgetsFor = (budgets: Record<string, number>) => ({
    admission: (
      c: { req: { header: (n: string) => string | undefined } },
      job: AdmissionJob,
    ) =>
      Promise.resolve(
        job.kind === 'ingest'
          ? {
              allow: true as const,
              budget: {
                tokens: budgets[c.req.header('x-reader') ?? ''] ?? 1e9,
              },
            }
          : { allow: true as const },
      ),
  });

  test('after the top-up, spend stays within the grant plus one call, charged to the live job', async () => {
    env.serve(big, bill(120, 'f5'), 'text/plain');
    paidPictures();
    const usage: UsageEvent[] = [];
    const t = { now: Date.now() };
    const a = app({
      ...FULL,
      pregenerateExamples: 'off',
      now: () => t.now,
      ...budgetsFor({ alice: 300, bob: 600 }),
      backgroundScope: unknown,
      onUsage: (e) => void usage.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(
      async () => {
        expect(stopped(await breakdownOf(a, docId))).toBeTruthy();
      },
      { timeout: 20_000 },
    );
    await settle(1000);
    const mark = usage.length;
    await ingestDoc(a, 'bob');
    for (let i = 0; i < 8; i++) {
      t.now += 61_000;
      await call(a, `/api/docs/${docId}/breakdown`, { reader: 'bob' });
      await picturesOf(a, docId, 'bob');
      await settle(700);
    }
    const after = usage.slice(mark);
    expect(after.length).toBeGreaterThan(0);
    // The grant, plus the one call each concurrent loop may overshoot by (a picture call is 100).
    expect(tokens(after)).toBeLessThanOrEqual(600 + 100);
    // Everything after the top-up belongs to bob's job, none to the ingest's own scope or none.
    expect(new Set(after.map((u) => u.job?.readerId))).toEqual(
      new Set(['bob']),
    );
    expect(new Set(after.map((u) => u.job?.jobId)).size).toBe(1);
  }, 60_000);

  test("another tier's reader opening the document never restarts this tier's pictures", async () => {
    const docId = await briefedWithoutPictures(40, 'f6');
    paidPictures();
    const usage: UsageEvent[] = [];
    const tierFor = (c: {
      req: { header: (n: string) => string | undefined };
    }) => (c.req.header('x-reader') === 'bob' ? { extract: 'tier-b' } : {});
    const a = app({
      ...FULL,
      pregenerateExamples: 'off',
      admission: allow,
      modelFor: (_j, c) => tierFor(c as never),
      // The default tier has a budget of 1 token, so its pictures stop after the first call.
      backgroundScope: (_d, tier) =>
        Promise.resolve(
          tier.endsWith('tier-b')
            ? { budget: { tokens: 1e9 } }
            : { budget: { tokens: 1 } },
        ),
      onUsage: (e) => void usage.push(e),
    });
    for (let i = 0; i < 4; i++) {
      await picturesOf(a, docId, 'alice');
      await settle(400);
    }
    await settle(1500);
    const defaultTierCalls = usage.filter(
      (u) => u.feature === 'pictures',
    ).length;
    expect(defaultTierCalls).toBeGreaterThan(0);
    modelCalls = 0;
    const mark = usage.length;
    const scopes: (string | undefined)[] = [];
    const orig = env.provider.generateObject.bind(env.provider);
    vi.spyOn(env.provider, 'generateObject').mockImplementation((req) => {
      scopes.push(currentJob()?.context.readerId);
      return orig(req);
    });
    await call(a, `/api/docs/${docId}/summary`, {
      reader: 'bob',
      method: 'HEAD',
    });
    await settle(3000);
    // No picture is drawn outside a job scope, and none is drawn at all for the other tier's open.
    expect(scopes.filter((s) => s === undefined)).toEqual([]);
    expect(usage.slice(mark).filter((u) => u.feature === 'pictures')).toEqual(
      [],
    );
    expect(modelCalls).toBe(0);
  }, 60_000);

  test('the example pass goes on after a top-up until every example exists', async () => {
    env.serve(big, bill(40, 'f2c'), 'text/plain');
    const usage: UsageEvent[] = [];
    const jobs: AdmissionJob[] = [];
    const t = { now: Date.now() };
    const budgets: Record<string, number> = { alice: 400, bob: 1_000_000 };
    const a = app({
      ...FULL,
      now: () => t.now,
      admission: (c, job) => {
        jobs.push(job);
        return Promise.resolve(
          job.kind === 'ingest'
            ? {
                allow: true,
                budget: {
                  tokens: budgets[c.req.header('x-reader') ?? ''] ?? 1e9,
                },
              }
            : { allow: true },
        );
      },
      backgroundScope: unknown,
      onUsage: (e) => void usage.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(
      async () => {
        expect(stopped(await breakdownOf(a, docId))).toBeTruthy();
      },
      { timeout: 20_000 },
    );
    await settle(800);
    const examplesAt = () =>
      usage.filter((u) => u.feature === 'examples').length;
    const before = examplesAt();
    expect(before).toBeLessThan(40);

    await ingestDoc(a, 'bob');
    for (let i = 0; i < 8; i++) {
      t.now += 61_000;
      await call(a, `/api/docs/${docId}/breakdown`, { reader: 'bob' });
      await picturesOf(a, docId, 'bob');
      await settle(500);
    }
    await vi.waitFor(
      () => {
        expect(examplesAt()).toBe(40);
      },
      { timeout: 30_000 },
    );
    // The summary and its pictures are the rest of "complete".
    await call(a, `/api/docs/${docId}/summary`, { reader: 'bob' });
    await vi.waitFor(async () => {
      const r = (await (
        await call(a, `/api/docs/${docId}/summary`, { reader: 'bob' })
      ).json()) as { status: string };
      expect(r.status).toBe('cached');
    });
    await vi.waitFor(async () => {
      const r = (await (
        await call(a, `/api/docs/${docId}/summary/pictures`, { reader: 'bob' })
      ).json()) as { status: string };
      expect(r.status).toMatch(/cached|none/);
    });
    await settle(500);
    await ingestDoc(a, 'carol');
    expect(jobs.at(-1)?.docComplete).toBe(true);
  }, 90_000);
});
