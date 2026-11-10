/** Hosting hooks part C (ADR 0018): settlement, the spend gate, read-only requests. */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
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
import {
  addBudget,
  bumpGrantEpoch,
  currentJob,
  grantEpoch,
  newSpend,
  runInJob,
  tierName,
  type JobScope,
  type UsageEvent,
} from '../core/cost/index.js';
import { MockProvider } from '../core/llm/mock.js';
import {
  AppError,
  IngestEvent,
  type LlmProvider,
} from '../core/model/index.js';
import { Limits, resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import type { Admission, JobEnd } from './admission.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';
import { createBreakdownService } from './breakdown.js';
import { routedRuntime } from './model-routing.js';
import { createSummaryService } from './summary.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
let provider: BreakdownProvider & { scen: ScenarioProvider };

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

const RATE = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };
const PRICES = { deterministic: RATE, 'tier-a': RATE, 'tier-b': RATE };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    ...(options.admission && !options.backgroundScope
      ? { backgroundScope: () => Promise.resolve(undefined) }
      : {}),
    logWriter: () => undefined,
    summaryWaitMs: 20,
    ...options,
    quote: { prices: PRICES, ...options.quote },
  });

const call = async (
  a: Hono,
  path: string,
  init: {
    method?: string;
    body?: unknown;
    reader?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
) =>
  a.request(path, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'x-reader': init.reader ?? 'alice',
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });

async function ingestDoc(a: Hono, reader = 'alice'): Promise<string> {
  const res = await call(a, '/api/ingest', { reader, body: { url } });
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

/** A stream whose first read fails, like a provider that goes down mid-request. */
const failingStream = (error: Error): never =>
  ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(error) }),
  }) as never;

const refOf = (kind: string): string => `ref-${kind}`;
const allowWithRef = (_c: Context, job: { kind: string }): Promise<Admission> =>
  Promise.resolve({ allow: true, ref: refOf(job.kind) });

describe('ref', () => {
  test('reaches every usage event of the job and onJobEnd', async () => {
    const events: UsageEvent[] = [];
    const ends: JobEnd[] = [];
    const a = app({
      admission: allowWithRef,
      onUsage: (e) => void events.push(e),
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a);
    await (
      await call(a, `/api/docs/${docId}/ask`, { body: { question: 'Who?' } })
    ).text();
    const questionUsage = events.filter((e) => e.job?.jobKind === 'question');
    expect(questionUsage.length).toBeGreaterThan(0);
    for (const e of questionUsage) expect(e.job?.ref).toBe('ref-question');
    const ingestUsage = events.filter((e) => e.job?.jobKind === 'ingest');
    for (const e of ingestUsage) expect(e.job?.ref).toBe('ref-ingest');
    expect(ends.map((e) => [e.job.jobKind, e.ref, e.outcome])).toEqual([
      ['ingest', 'ref-ingest', 'ok'],
      ['question', 'ref-question', 'ok'],
    ]);
    expect(ends[1]?.job.ref).toBe('ref-question');
  });

  test.each([
    ['empty', ''],
    ['too long', 'a'.repeat(129)],
    ['spaces', 'a b'],
    ['punctuation', 'a.b'],
    ['a number', 42],
  ])(
    'an invalid ref (%s) fails closed with 500 and no work',
    async (_n, ref) => {
      const calls = modelCalls();
      const ends: JobEnd[] = [];
      const a = app({
        admission: () => Promise.resolve({ allow: true, ref } as Admission),
        onJobEnd: (e) => void ends.push(e),
      });
      const res = await call(a, '/api/ingest', { body: { url } });
      expect(res.status).toBe(500);
      expect(calls()).toBe(0);
      expect(await env.registry.list()).toEqual([]);
      expect(ends).toEqual([]);
    },
  );

  test('the longest valid ref is accepted', async () => {
    const ref = 'A_-9'.repeat(32);
    expect(ref).toHaveLength(128);
    const ends: JobEnd[] = [];
    const a = app({
      admission: () => Promise.resolve({ allow: true, ref }),
      onJobEnd: (e) => void ends.push(e),
    });
    await ingestDoc(a);
    expect(ends[0]?.ref).toBe(ref);
  });
});

// ---------------------------------------------------------------------------------------------

type Kind = 'ingest' | 'question' | 'chip' | 'locate' | 'scenario' | 'example';
const KINDS: Kind[] = [
  'ingest',
  'question',
  'chip',
  'locate',
  'scenario',
  'example',
];
const jobKindOf = (kind: Kind): string => (kind === 'chip' ? 'question' : kind);

describe('onJobEnd: exactly once per admitted job', () => {
  let ends: JobEnd[];
  let release: () => void;
  let hold: Promise<void>;
  beforeEach(() => {
    ends = [];
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  afterEach(() => {
    release();
  });

  const hosted = (extra: AppOptions = {}): Hono =>
    app({
      admission: allowWithRef,
      onJobEnd: (e) => void ends.push(e),
      ...extra,
    });

  /** Runs one job of `kind` to the end of its response. */
  async function drive(
    kind: Kind,
    a: Hono,
    docId: string | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const doc = `/api/docs/${docId ?? 'x'}`;
    switch (kind) {
      case 'ingest':
        await (await call(a, '/api/ingest', { body: { url }, signal })).text();
        return;
      case 'question':
        await (
          await call(a, `${doc}/ask`, {
            body: { question: 'Who pays?' },
            signal,
          })
        ).text();
        return;
      case 'chip':
        await (
          await call(a, `${doc}/ask`, {
            body: { chipId: 'what-changes' },
            signal,
          })
        ).text();
        return;
      case 'locate':
        await (
          await call(a, `${doc}/locate`, {
            body: { text: 'The department shall publish a rule.' },
          })
        ).text();
        return;
      case 'scenario':
        await (
          await call(a, `${doc}/scenario`, { body: { subject: 'a farmer' } })
        ).text();
        return;
      case 'example':
        await (await call(a, `${doc}/sections/sec-2/example`)).text();
        return;
    }
  }

  const endsOf = (kind: Kind): JobEnd[] =>
    ends.filter((e) => e.job.jobKind === jobKindOf(kind));

  /** Waits for the end, then proves nothing else follows it. */
  async function onlyEnd(kind: Kind): Promise<JobEnd> {
    await vi.waitFor(() => {
      expect(endsOf(kind)).toHaveLength(1);
    });
    await sleep(150);
    expect(endsOf(kind)).toHaveLength(1);
    const end = endsOf(kind)[0];
    if (!end) throw new Error('no end');
    expect(end.ref).toBe(refOf(jobKindOf(kind)));
    expect(end.job.ref).toBe(end.ref);
    return end;
  }

  /** The doc for every kind but ingest; the setup ingest's own end is a different kind. */
  async function setup(kind: Kind, a: Hono): Promise<string | undefined> {
    return kind === 'ingest' ? undefined : ingestDoc(a);
  }

  /** Makes this kind's model work fail. */
  function breakModel(kind: Kind): void {
    const failure = new AppError('PROVIDER_ERROR', 'down', {
      userMessage: 'The model is down.',
    });
    if (kind === 'ingest') {
      vi.spyOn(env.embedder, 'embed').mockRejectedValue(failure);
      return;
    }
    vi.spyOn(provider, 'generateObject').mockRejectedValue(failure);
    vi.spyOn(provider, 'streamText').mockImplementation(() =>
      failingStream(failure),
    );
  }

  test.each(KINDS)('%s: ok', async (kind) => {
    const a = hosted();
    const docId = await setup(kind, a);
    await drive(kind, a, docId);
    const end = await onlyEnd(kind);
    expect(end.outcome).toBe('ok');
    expect(end.delivered).toBe('full');
    expect(end.error).toBeUndefined();
  });

  test.each(KINDS)(
    '%s: provider error is failed with the plain message',
    async (kind) => {
      const a = hosted();
      const docId = await setup(kind, a);
      breakModel(kind);
      if (kind === 'ingest') {
        await drive(kind, a, docId);
      } else if (kind === 'example') {
        await call(a, `/api/docs/${docId ?? 'x'}/sections/sec-2/example`);
      } else {
        await drive(kind, a, docId).catch(() => undefined);
      }
      const end = await onlyEnd(kind);
      expect(end.outcome).toBe('failed');
      expect(end.error?.code).toBeDefined();
      expect(JSON.stringify(end)).not.toContain('down'.repeat(9));
    },
  );

  test.each(['question', 'chip', 'ingest'] as const)(
    '%s: the reader disconnecting is aborted',
    async (kind) => {
      const a = hosted();
      const docId = await setup(kind, a);
      if (kind === 'ingest')
        vi.spyOn(env.embedder, 'embed').mockImplementation(() =>
          hold.then(() => ({ vectors: [], tokens: 0 })),
        );
      else
        vi.spyOn(provider, 'streamText').mockImplementation(() =>
          (async function* () {
            await hold;
            yield { type: 'text' as const, text: 'late' };
          })(),
        );
      const controller = new AbortController();
      const pending = drive(kind, a, docId, controller.signal).catch(
        () => undefined,
      );
      await sleep(100);
      controller.abort();
      await pending;
      const end = await onlyEnd(kind);
      expect(end.outcome).toBe('aborted');
      expect(end.delivered).toBe('none');
      expect(end.error).toBeUndefined();
      // The work finishing later does not end the job a second time.
      release();
      await sleep(200);
      expect(endsOf(kind)).toHaveLength(1);
    },
  );

  test.each(['question', 'chip'] as const)(
    '%s: leaving after some text was streamed is aborted with delivered partial',
    async (kind) => {
      const a = hosted();
      const docId = await setup(kind, a);
      vi.spyOn(provider, 'streamText').mockImplementation(() =>
        (async function* () {
          yield { type: 'text' as const, text: 'The department shall ' };
          await hold;
        })(),
      );
      const controller = new AbortController();
      const pending = drive(kind, a, docId, controller.signal).catch(
        () => undefined,
      );
      await sleep(250);
      controller.abort();
      await pending;
      const end = await onlyEnd(kind);
      expect(end.outcome).toBe('aborted');
      expect(end.delivered).toBe('partial');
    },
  );

  test('question: a failure after some text was streamed is failed with delivered partial', async () => {
    const a = hosted();
    const docId = await setup('question', a);
    vi.spyOn(provider, 'streamText').mockImplementation(() => {
      let sent = false;
      return {
        [Symbol.asyncIterator]: () => ({
          next: () => {
            if (sent)
              return Promise.reject(new AppError('PROVIDER_ERROR', 'x'));
            sent = true;
            return Promise.resolve({
              done: false,
              value: { type: 'text', text: 'The department ' },
            });
          },
        }),
      } as never;
    });
    await drive('question', a, docId).catch(() => undefined);
    const end = await onlyEnd('question');
    expect(end.outcome).toBe('failed');
    expect(end.delivered).toBe('partial');
  });

  test('ingest: a source that changed after admission is failed', async () => {
    let admissions = 0;
    const a = hosted({
      admission: (c, job) => {
        // The bytes change once the host has seen the measured document.
        if (++admissions === 1)
          env.serve(
            url,
            {
              bytes: new TextEncoder().encode(
                'Another Bill\nSECTION 1. Other\nA wholly different sentence about gardens.\n',
              ),
            },
            'text/plain',
          );
        return allowWithRef(c, job);
      },
    });
    env.serve(url, makeSectionedText(), 'text/plain');
    const res = await call(a, '/api/ingest', { body: { url } });
    expect(await res.text()).toContain('"type":"error"');
    const end = await onlyEnd('ingest');
    expect(end.outcome).toBe('failed');
  });

  test('ingest: a wrapper page that lists candidate files ends the job as failed', async () => {
    env.serve(
      url,
      {
        bytes: new TextEncoder().encode(
          '<html><body><a href="https://govinfo.gov/b.pdf">the bill</a></body></html>',
        ),
      },
      'text/html',
    );
    const a = hosted();
    const text = await (await call(a, '/api/ingest', { body: { url } })).text();
    const end = await onlyEnd('ingest');
    // Either way the job ends once; a wrapper page registers nothing.
    if (text.includes('candidates')) expect(end.outcome).toBe('failed');
  });

  test.each(['question', 'chip', 'locate', 'scenario', 'example'] as const)(
    '%s: a closed spend gate is failed with BUDGET_EXHAUSTED and costs nothing',
    async (kind) => {
      let open = true;
      const a = hosted({ spendGate: () => open });
      const docId = await setup(kind, a);
      const calls = modelCalls();
      const before = calls();
      open = false;
      await drive(kind, a, docId).catch(() => undefined);
      const end = await onlyEnd(kind);
      expect(end.outcome).toBe('failed');
      expect(end.error?.code).toBe('BUDGET_EXHAUSTED');
      expect(calls()).toBe(before);
    },
  );

  test('a host callback that throws does not change the response', async () => {
    const a = hosted({
      onJobEnd: () => {
        throw new Error('host down');
      },
    });
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/scenario`, {
      body: { subject: 'a farmer' },
    });
    expect(res.status).toBe(200);
  });

  test('a job that is not admitted (a metadata chip, a refusal, no admission hook) is never reported', async () => {
    const a = hosted();
    const docId = await ingestDoc(a);
    ends.length = 0;
    await (
      await call(a, `/api/docs/${docId}/ask`, { body: { chipId: 'sponsors' } })
    ).text();
    const refused = hosted({
      admission: () =>
        Promise.resolve({
          allow: false,
          status: 403,
          error: { code: 'NO', message: 'no' },
        }),
    });
    await call(refused, '/api/ingest', { body: { url } });
    const plain = app({ onJobEnd: (e) => void ends.push(e) });
    await ingestDoc(plain);
    await sleep(100);
    expect(ends).toEqual([]);
  });

  test('a second look at a running example is aborted, not left hanging', async () => {
    const a = hosted();
    const docId = await ingestDoc(a);
    provider.scen.behavior = () =>
      hold.then(() => Promise.reject(new AppError('PROVIDER_ERROR')));
    const path = `/api/docs/${docId}/sections/sec-2/example`;
    await (await call(a, path)).text();
    await (await call(a, path)).text();
    release();
    await vi.waitFor(() => {
      expect(endsOf('example').length).toBeGreaterThanOrEqual(1);
    });
    await sleep(200);
    // Admission happens only when a generation would start: one job, one end.
    expect(endsOf('example')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------

describe('spend gate', () => {
  test('Limits.meter refuses before every call, background included', async () => {
    const limits = new Limits({
      maxConcurrentIngest: 2,
      maxConcurrentAsk: 4,
      maxCallsPerMinute: 1000,
    });
    const base = new MockProvider();
    const spy = vi.spyOn(base, 'generateObject');
    let open = true;
    const scope: JobScope = {
      context: { readerId: 'r', jobKind: 'ingest', jobId: 'j' },
      spendGate: () => open,
      spent: newSpend(),
    };
    const req = {
      system: 's',
      prompt: 'p',
      schema: { parse: (v: unknown) => v },
      schemaName: 'x',
      maxTokens: 10,
    } as never;
    const metered = limits.meter(base);
    const paced = limits.paced(base, { background: true });
    await runInJob(scope, async () => {
      open = false;
      for (const p of [metered, paced])
        await expect(p.generateObject(req)).rejects.toMatchObject({
          code: 'BUDGET_EXHAUSTED',
          details: { reason: 'spend_gate' },
        });
      expect(() =>
        metered.streamText({ system: 's', prompt: 'p', maxTokens: 1 } as never),
      ).toThrow();
      expect(spy).not.toHaveBeenCalled();
      // A gate that throws, or answers anything but true, is closed.
      scope.spendGate = () => {
        throw new Error('x');
      };
      await expect(metered.generateObject(req)).rejects.toMatchObject({
        code: 'BUDGET_EXHAUSTED',
      });
      scope.spendGate = (() => 1) as never;
      await expect(metered.generateObject(req)).rejects.toMatchObject({
        code: 'BUDGET_EXHAUSTED',
      });
    });
  });

  test('stops background generation cleanly, keeps what is written, and a later request resumes', async () => {
    const lines = ['Synthetic Many Parts Bill'];
    for (let i = 1; i <= 40; i++)
      lines.push(
        `SECTION ${String(i)}. Heading ${String(i)}`,
        `The department shall do thing number ${String(i)} for every garden group in the state.`,
      );
    env.serve(
      url,
      { bytes: new TextEncoder().encode(`${lines.join('\n')}\n`) },
      'text/plain',
    );
    let open = true;
    let batches = 0;
    provider.gate = () => {
      if (++batches === 2) open = false;
      return Promise.resolve();
    };
    const a = app({
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
      spendGate: () => open,
      admission: allowWithRef,
    });
    const docId = await ingestDoc(a);
    const get = async () =>
      (await (await call(a, `/api/docs/${docId}/breakdown`)).json()) as {
        status: string;
        briefs?: unknown[];
        stoppedReason?: string;
        progress?: { stoppedReason?: string };
      };
    await get();
    let stoppedSeen: Awaited<ReturnType<typeof get>> | undefined;
    await vi.waitFor(
      async () => {
        const r = await get();
        if (r.stoppedReason ?? r.progress?.stoppedReason) stoppedSeen = r;
        expect(stoppedSeen).toBeDefined();
      },
      { timeout: 15_000 },
    );
    expect(
      stoppedSeen?.stoppedReason ?? stoppedSeen?.progress?.stoppedReason,
    ).toBe('spend_gate');
    const kept = stoppedSeen?.briefs?.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    // While closed, nothing is started.
    const callsClosed = provider.breakdownCalls;
    for (let i = 0; i < 3; i++) await get();
    await sleep(200);
    expect(provider.breakdownCalls).toBe(callsClosed);
    // Reopened: the next generating look goes on from the written parts, at once.
    open = true;
    await vi.waitFor(
      async () => {
        const r = await get();
        expect(r.status).toBe('cached');
        expect(r.stoppedReason).toBeUndefined();
        expect(r.briefs?.length).toBeGreaterThan(kept);
      },
      { timeout: 20_000 },
    );
  }, 60_000);

  test('a question is refused with no provider call while the gate is closed', async () => {
    const open = { v: true };
    const a = app({ spendGate: () => open.v });
    const docId = await ingestDoc(a);
    const calls = modelCalls();
    open.v = false;
    const text = await (
      await call(a, `/api/docs/${docId}/ask`, { body: { question: 'Who?' } })
    ).text();
    expect(text).toContain('BUDGET_EXHAUSTED');
    expect(calls()).toBe(0);
    open.v = true;
    expect(
      await (
        await call(a, `/api/docs/${docId}/ask`, { body: { question: 'Who?' } })
      ).text(),
    ).toContain('"type":"done"');
  });
});

// ---------------------------------------------------------------------------------------------

describe('readOnly', () => {
  const guest = (c: Context): boolean => c.req.header('x-guest') === '1';

  test('every route serves cached results only: zero model calls with a funded live scope and missing parts', async () => {
    const usage: UsageEvent[] = [];
    const admitted: string[] = [];
    const a = app({
      readOnly: guest,
      admission: (_c, job) => {
        admitted.push(job.kind);
        return Promise.resolve({ allow: true, budget: { tokens: 1e9 } });
      },
      backgroundScope: () => Promise.resolve({ budget: { tokens: 1e9 } }),
      onUsage: (e) => void usage.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    await sleep(100);
    const calls = modelCalls();
    const usageBefore = usage.length;
    const admissionsBefore = admitted.length;
    const g = { 'x-guest': '1' };
    const doc = `/api/docs/${docId}`;
    const probes: [string, string, unknown, number][] = [
      ['GET', '/api/health', undefined, 200],
      ['GET', '/api/config', undefined, 200],
      ['GET', '/api/docs', undefined, 200],
      ['GET', doc, undefined, 200],
      ['GET', `${doc}/summary`, undefined, 200],
      ['HEAD', `${doc}/summary`, undefined, 200],
      ['GET', `${doc}/summary/pictures`, undefined, 200],
      ['GET', `${doc}/breakdown`, undefined, 200],
      ['HEAD', `${doc}/breakdown`, undefined, 200],
      ['GET', `${doc}/breakdown/pictures`, undefined, 200],
      ['GET', `${doc}/sections/sec-2`, undefined, 200],
      ['GET', `${doc}/sections/sec-2/example`, undefined, 200],
      ['HEAD', `${doc}/sections/sec-2/example`, undefined, 200],
      ['POST', '/api/quote', { url }, 403],
      ['POST', '/api/ingest', { url }, 403],
      ['POST', `${doc}/ask`, { question: 'Who pays?' }, 403],
      ['POST', `${doc}/ask`, { chipId: 'what-changes' }, 403],
      ['POST', `${doc}/ask`, { chipId: 'sponsors' }, 403],
      ['POST', `${doc}/scenario`, { subject: 'a farmer' }, 200],
      [
        'POST',
        `${doc}/locate`,
        { text: 'The department shall publish a rule.' },
        200,
      ],
      [
        'POST',
        `${doc}/locate/versions`,
        { text: 'The department shall publish a rule.' },
        200,
      ],
    ];
    for (const [method, path, body, status] of probes) {
      const res = await call(a, path, {
        method,
        ...(body === undefined ? {} : { body }),
        headers: g,
      });
      const text = await res.text();
      expect(res.status, `${method} ${path}`).toBe(status);
      if (status === 200 && method === 'POST')
        expect(text, `${method} ${path}`).toContain('disabled');
    }
    const config = (await (
      await call(a, '/api/config', { headers: g })
    ).json()) as Record<string, unknown>;
    expect(config).toMatchObject({
      freeformEnabled: false,
      scenariosEnabled: false,
      locateEnabled: false,
    });
    // Let anything wrongly started show itself.
    await sleep(400);
    expect(calls()).toBe(0);
    expect(usage.length).toBe(usageBefore);
    expect(admitted.length).toBe(admissionsBefore);
    expect(
      await call(a, `${doc}/summary`, { headers: g }).then((r) => r.json()),
    ).toEqual({ status: 'disabled' });
    expect(
      await call(a, `${doc}/breakdown`, { headers: g }).then((r) => r.json()),
    ).toMatchObject({ status: 'disabled' });
  });

  test('a signed-in reader still generates, and the guest then sees the cached result', async () => {
    const a = app({
      readOnly: guest,
      admission: allowWithRef,
      backgroundScope: () => Promise.resolve({ budget: { tokens: 1e9 } }),
    });
    const docId = await ingestDoc(a, 'alice');
    const g = { 'x-guest': '1' };
    const summary = (headers?: Record<string, string>) =>
      call(a, `/api/docs/${docId}/summary`, {
        ...(headers ? { headers } : {}),
      }).then((r) => r.json() as Promise<{ status: string }>);
    expect((await summary(g)).status).toBe('disabled');
    await summary();
    await vi.waitFor(async () => {
      expect((await summary()).status).toBe('cached');
    });
    expect((await summary(g)).status).toBe('cached');
  });

  test('a hook that throws or answers with anything but false is read-only', async () => {
    for (const hook of [
      () => {
        throw new Error('down');
      },
      () => undefined as unknown as boolean,
      () => 'no' as unknown as boolean,
    ]) {
      const calls = modelCalls();
      const a = app({ readOnly: hook });
      const res = await call(a, '/api/ingest', { body: { url } });
      expect(res.status).toBe(403);
      expect(calls()).toBe(0);
      vi.restoreAllMocks();
    }
    const open = app({ readOnly: () => false });
    expect(await ingestDoc(open)).toBeTruthy();
  });

  test('without the hook nothing changes', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await call(a, `/api/docs/${docId}/ask`, {
      body: { question: 'Who?' },
    });
    expect(await res.text()).toContain('"type":"done"');
  });
});

// ---------------------------------------------------------------------------------------------

describe('a top-up clears marks for its own tier only', () => {
  /** Providers by model, so two tiers have different cache keys and can fail separately. */
  function tiered() {
    const failing = new Set<string>();
    const made = new Map<string, BreakdownProvider>();
    env.runtime.providerFor = (_role, model) => {
      const name = model ?? 'default';
      let p = made.get(name);
      if (!p) {
        p = breakdownProvider(scenarioProvider(new MockProvider(model)));
        p.behavior = () => {
          if (failing.has(name)) throw new AppError('PROVIDER_ERROR', 'down');
          return {
            briefs: [],
          };
        };
        made.set(name, p);
      }
      return p;
    };
    return { failing, made };
  }
  const scopeFor = (tier: string): JobScope => ({
    context: { readerId: 'r', jobKind: 'ingest', jobId: tier },
    models: { answer: tier, extract: tier },
    spent: newSpend(),
  });

  test('breakdown: resume(tier A) restarts A and leaves B cooling down', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const { failing, made } = tiered();
    const service = createBreakdownService(routedRuntime(env.runtime), {
      publicMode: false,
      waitMs: 20,
      pregenerateExamples: 'off',
    });
    failing.add('tier-a');
    failing.add('tier-b');
    const inTier = <T>(tier: string, fn: () => Promise<T>): Promise<T> =>
      runInJob(scopeFor(tier), fn);
    for (const tier of ['tier-a', 'tier-b'])
      await inTier(tier, () => service.get(docId, { wait: false }));
    await vi.waitFor(async () => {
      for (const tier of ['tier-a', 'tier-b'])
        await expect(
          inTier(tier, () => service.get(docId, { wait: false })),
        ).rejects.toMatchObject({
          code: 'PROVIDER_ERROR',
        });
    });
    const liveA = scopeFor('tier-a');
    failing.clear();
    service.resume?.(docId, liveA);
    const callsA = made.get('tier-a')?.breakdownCalls ?? 0;
    const callsB = made.get('tier-b')?.breakdownCalls ?? 0;
    // A may go on at once; B still cools down.
    await runInJob(liveA, () => service.get(docId, { wait: false }));
    await sleep(100);
    expect(made.get('tier-a')?.breakdownCalls).toBeGreaterThan(callsA);
    await expect(
      inTier('tier-b', () => service.get(docId, { wait: false })),
    ).rejects.toMatchObject({
      code: 'PROVIDER_ERROR',
    });
    expect(made.get('tier-b')?.breakdownCalls).toBe(callsB);
  });

  test('summary: resume(tier A) restarts A and leaves B cooling down', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const { made } = tiered();
    const summary = createSummaryService(routedRuntime(env.runtime), {
      publicMode: false,
      waitMs: 20,
    });
    /** Every call this tier's model gets fails, and is counted. */
    const failing = (name: string) => {
      const p = env.runtime.providerFor('answer', name);
      const failure = new AppError('PROVIDER_ERROR', 'down');
      const calls = { n: 0 };
      vi.spyOn(p, 'generateObject').mockImplementation(() => {
        calls.n++;
        return Promise.reject(failure);
      });
      vi.spyOn(p, 'streamText').mockImplementation(() => {
        calls.n++;
        return failingStream(failure);
      });
      return calls;
    };
    const spyA = failing('tier-a');
    const spyB = failing('tier-b');
    expect(made.size).toBe(2);
    const look = (tier: string) =>
      runInJob(scopeFor(tier), () => summary.get(docId, { wait: true }));
    await look('tier-a');
    await look('tier-b');
    await vi.waitFor(async () => {
      expect((await look('tier-a')).status).toBe('disabled');
      expect((await look('tier-b')).status).toBe('disabled');
    });
    spyA.n = 0;
    spyB.n = 0;
    summary.resume?.(docId, tierName(scopeFor('tier-a').models));
    await look('tier-a');
    await look('tier-b');
    await sleep(200);
    expect(spyA.n).toBeGreaterThan(0);
    expect(spyB.n).toBe(0);
  });
});

describe('example passes of two tiers interleave while one tier is spent', () => {
  test('the spent tier stops on its own scope and key; the other finishes its pass', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const jobsSeen: Record<string, Set<string>> = {};
    const made = new Map<string, BreakdownProvider>();
    env.runtime.providerFor = (_role, model) => {
      const name = model ?? 'default';
      let p = made.get(name);
      if (!p) {
        const base = new MockProvider(model);
        const scen = scenarioProvider(base);
        scen.onScenario = () => {
          (jobsSeen[name] ??= new Set()).add(
            // The job each example call ran in.
            currentJobId(),
          );
        };
        p = breakdownProvider(scen);
        made.set(name, p);
      }
      return p;
    };
    const service = createBreakdownService(routedRuntime(env.runtime), {
      publicMode: false,
      waitMs: 20,
      pregenerateExamples: 'all',
      breakdownMaxUnits: 'all',
    });
    const scope = (tier: string, tokens: number): JobScope => ({
      context: {
        readerId: tier,
        jobKind: 'ingest',
        jobId: `job-${tier}`,
        docId,
      },
      models: { answer: tier, extract: tier },
      budget: { tokens },
      spent: newSpend(),
    });
    const richA = scope('tier-a', 1e9);
    // Tier B can pay for its breakdown and about one example call, no more.
    const poorB = scope('tier-b', 30);
    const look = (s: JobScope) =>
      runInJob(s, () => service.get(docId, { wait: false }));
    await Promise.all([look(richA), look(poorB)]);
    const done = async (s: JobScope) => {
      const r = await look(s);
      return r.status === 'cached' ? r : undefined;
    };
    await vi.waitFor(
      async () => {
        expect(await done(richA)).toBeDefined();
      },
      { timeout: 15_000 },
    );
    // Keep asking on both tiers so each tier's pass is woken by its own scope.
    await vi.waitFor(
      async () => {
        await look(richA);
        await look(poorB);
        expect((await service.examplesComplete?.(docId)) ?? true).toBeDefined();
        const calls = jobsSeen['tier-a']?.size ?? 0;
        expect(calls).toBeGreaterThan(0);
        const b = await look(poorB);
        expect(b.progress?.stoppedReason ?? b.stoppedReason).toBeDefined();
      },
      { timeout: 20_000 },
    );
    const a1 = await look(richA);
    // Tier A's pass runs under tier A's job only; tier B's under B's. Neither borrows the other's.
    expect([...(jobsSeen['tier-a'] ?? [])]).toEqual(['job-tier-a']);
    expect(
      [...(jobsSeen['tier-b'] ?? [])].every((j) => j === 'job-tier-b'),
    ).toBe(true);
    expect(a1.progress?.stoppedReason).toBeUndefined();
    const b1 = await look(poorB);
    expect(b1.progress?.stoppedReason ?? b1.stoppedReason).toBeDefined();
  }, 60_000);
});

function currentJobId(): string {
  return currentJob()?.context.jobId ?? 'none';
}
// Types used above.
export type { LlmProvider };

// ---------------------------------------------------------------------------------------------

describe('a failed scenario attempt is not cached as an answer', () => {
  const scenario = async (a: Hono, docId: string, subject: string) =>
    (await (
      await call(a, `/api/docs/${docId}/scenario`, { body: { subject } })
    ).json()) as { status: string };

  test('after a provider error, the next request retries and settles by its own outcome', async () => {
    const ends: JobEnd[] = [];
    const a = app({
      admission: allowWithRef,
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a);
    provider.scen.behavior = () =>
      Promise.reject(new AppError('PROVIDER_ERROR', 'down'));
    expect((await scenario(a, docId, 'a farmer')).status).toBe('none');
    delete provider.scen.behavior;
    const calls = provider.scen.scenarioCalls;
    expect((await scenario(a, docId, 'a farmer')).status).toBe('ok');
    expect(provider.scen.scenarioCalls).toBeGreaterThan(calls);
    expect(
      ends.filter((e) => e.job.jobKind === 'scenario').map((e) => e.outcome),
    ).toEqual(['failed', 'ok']);
  });

  test('a gate that closes and reopens does not poison the subject', async () => {
    let open = true;
    const ends: JobEnd[] = [];
    const a = app({
      admission: allowWithRef,
      spendGate: () => open,
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a);
    open = false;
    expect((await scenario(a, docId, 'a baker')).status).toBe('none');
    open = true;
    expect((await scenario(a, docId, 'a baker')).status).toBe('ok');
    expect(
      ends.filter((e) => e.job.jobKind === 'scenario').map((e) => e.outcome),
    ).toEqual(['failed', 'ok']);
  });

  test('a genuine "no scenario" from the model is still cached', async () => {
    const a = app({ admission: allowWithRef });
    const docId = await ingestDoc(a);
    provider.scen.behavior = () =>
      Promise.resolve({
        object: { frames: [] },
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as never;
    const first = await scenario(a, docId, 'a gardener');
    delete provider.scen.behavior;
    const calls = provider.scen.scenarioCalls;
    const second = await scenario(a, docId, 'a gardener');
    expect(second.status).toBe(first.status);
    if (first.status === 'none')
      expect(provider.scen.scenarioCalls).toBe(calls);
  });
});

const manyParts = (count: number): { bytes: Uint8Array } => {
  const lines = ['Synthetic Many Parts Bill'];
  for (let i = 1; i <= count; i++)
    lines.push(
      `SECTION ${String(i)}. Heading ${String(i)}`,
      `The department shall do thing number ${String(i)} for every garden group in the state.`,
    );
  return { bytes: new TextEncoder().encode(`${lines.join('\n')}\n`) };
};

describe('a paid re-ingest while the live scope still has budget', () => {
  test('its budget is added, later calls run under its ref, and its end says the grant was used', async () => {
    env.serve(url, manyParts(40), 'text/plain');
    const usage: UsageEvent[] = [];
    const ends: JobEnd[] = [];
    const a = app({
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
      admission: (c, job) =>
        Promise.resolve({
          allow: true,
          ref: `ref-${c.req.header('x-reader') ?? ''}`,
          ...(job.kind === 'ingest'
            ? {
                budget: {
                  tokens: c.req.header('x-reader') === 'alice' ? 60 : 1e9,
                },
              }
            : {}),
        }),
      backgroundScope: () => Promise.resolve(undefined),
      onUsage: (e) => void usage.push(e),
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    const spentByIngest = usage.reduce(
      (n, e) => n + e.usage.inputTokens + e.usage.outputTokens,
      0,
    );
    // Precondition: alice's scope still has budget, but nowhere near enough for 40 parts.
    expect(spentByIngest).toBeLessThan(60);
    await ingestDoc(a, 'bob');
    const bobEnd = ends.find((e) => e.ref === 'ref-bob');
    expect(bobEnd).toMatchObject({
      outcome: 'ok',
      delivered: 'full',
      granted: 'used',
    });
    const mark = usage.length;
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(
      async () => {
        const r = (await (
          await call(a, `/api/docs/${docId}/breakdown`)
        ).json()) as { status: string; briefs?: unknown[] };
        expect(r.status).toBe('cached');
        expect(r.briefs).toHaveLength(40);
      },
      { timeout: 20_000 },
    );
    const after = usage.slice(mark).filter((e) => e.feature === 'breakdown');
    expect(after.length).toBeGreaterThanOrEqual(4);
    expect(new Set(after.map((e) => e.job?.ref))).toEqual(new Set(['ref-bob']));
  }, 40_000);

  test('when nothing is left to generate, the end says the grant was unused', async () => {
    const ends: JobEnd[] = [];
    const a = app({
      pregenerateExamples: 'off',
      admission: allowWithRef,
      backgroundScope: () => Promise.resolve(undefined),
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    const get = async (path: string) =>
      (await (await call(a, `/api/docs/${docId}/${path}`)).json()) as {
        status: string;
      };
    await vi.waitFor(async () => {
      expect((await get('summary')).status).toBe('cached');
    });
    await vi.waitFor(async () => {
      expect((await get('breakdown')).status).toBe('cached');
    });
    for (const p of ['summary/pictures', 'breakdown/pictures'])
      await vi.waitFor(async () => {
        expect((await get(p)).status).toMatch(/cached|none/);
      });
    await ingestDoc(a, 'bob');
    expect(
      ends.find((e) => e.ref === 'ref-ingest' && e.job.readerId === 'bob'),
    ).toMatchObject({ outcome: 'ok', granted: 'unused' });
  }, 40_000);
});

describe('a tier with budget does not wait behind another tier on a shared breakdown', () => {
  test("tier A's budget stop does not hold tier B back", async () => {
    env.serve(url, manyParts(40), 'text/plain');
    const a = app();
    const docId = await ingestDoc(a);
    const made = new Map<string, BreakdownProvider>();
    env.runtime.providerFor = (_role, model) => {
      const name = model ?? 'default';
      let p = made.get(name);
      if (!p) {
        p = breakdownProvider(scenarioProvider(new MockProvider(model)));
        made.set(name, p);
      }
      return p;
    };
    const service = createBreakdownService(routedRuntime(env.runtime), {
      publicMode: false,
      waitMs: 20,
      pregenerateExamples: 'off',
      breakdownMaxUnits: 'all',
    });
    // Same answer model, different extract model: one breakdown, two tiers.
    const scope = (extract: string, tokens: number): JobScope => ({
      context: { readerId: extract, jobKind: 'ingest', jobId: extract, docId },
      models: { answer: 'shared', extract },
      budget: { tokens },
      spent: newSpend(),
    });
    const poorA = scope('x-a', 30);
    const richB = scope('x-b', 1e9);
    const look = (s: JobScope) =>
      runInJob(s, () => service.get(docId, { wait: false }));
    await look(poorA);
    await vi.waitFor(
      async () => {
        const r = await look(poorA);
        expect(r.stoppedReason ?? r.progress?.stoppedReason).toBeDefined();
      },
      { timeout: 15_000 },
    );
    // No clock moves: B must not be told to wait out A's stop.
    await look(richB);
    await vi.waitFor(
      async () => {
        const r = await look(richB);
        expect(r.status).toBe('cached');
        expect(r.briefs).toHaveLength(40);
        expect(r.stoppedReason).toBeUndefined();
      },
      { timeout: 20_000 },
    );
  }, 40_000);
});

describe('settling an ingest the moment it is registered', () => {
  /** Runs an ingest, holds `hold` open, aborts the request, then releases. */
  async function abortWhileHeld(options: {
    install: (hold: () => Promise<void>) => void;
    admission?: AppOptions['admission'];
  }) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    const ends: JobEnd[] = [];
    const usage: UsageEvent[] = [];
    options.install(async () => {
      held = true;
      await gate;
    });
    const a = app({
      admission: options.admission ?? allowWithRef,
      onUsage: (e) => void usage.push(e),
      onJobEnd: (e) => void ends.push(e),
    });
    const controller = new AbortController();
    const res = await call(a, '/api/ingest', {
      body: { url },
      signal: controller.signal,
    });
    const reader = res.body?.getReader();
    await vi.waitFor(() => {
      expect(held).toBe(true);
    });
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await sleep(200);
    release();
    await sleep(400);
    const docs = await env.registry.list();
    const mark = usage.length;
    if (docs[0]) {
      await call(a, `/api/docs/${docs[0].docId}/summary`);
      await sleep(600);
    }
    return { ends, docs, laterCalls: usage.slice(mark) };
  }

  test('a reader who leaves while the document is being written is aborted, and the grant is never installed', async () => {
    const out = await abortWhileHeld({
      install: (hold) => {
        const add = env.registry.add.bind(env.registry);
        vi.spyOn(env.registry, 'add').mockImplementation(async (...args) => {
          await hold();
          return add(...args);
        });
      },
    });
    expect(out.ends).toHaveLength(1);
    expect(out.ends[0]).toMatchObject({
      outcome: 'aborted',
      delivered: 'none',
    });
    // The host releases this admission, so nothing may be spent under its ref.
    expect(out.laterCalls).toEqual([]);
  });

  test('the same on the reused-document path', async () => {
    await ingestDoc(app()); // already registered and indexed
    const out = await abortWhileHeld({
      install: (hold) => {
        const touch = env.registry.touch.bind(env.registry);
        vi.spyOn(env.registry, 'touch').mockImplementation(async (...args) => {
          await hold();
          return touch(...args);
        });
      },
    });
    expect(out.ends).toHaveLength(1);
    expect(out.ends[0]?.outcome).toBe('aborted');
    expect(out.laterCalls).toEqual([]);
  });

  test('a reader who leaves after the document is registered still settles ok/full, and the grant is installed', async () => {
    let registered = false;
    const out = await abortWhileHeld({
      install: (hold) => {
        const add = env.registry.add.bind(env.registry);
        vi.spyOn(env.registry, 'add').mockImplementation(async (...args) => {
          const entry = await add(...args);
          registered = true;
          return entry;
        });
        // The cap check right after registration is held.
        const candidates = env.registry.evictionCandidates.bind(env.registry);
        vi.spyOn(env.registry, 'evictionCandidates').mockImplementation(
          async (...args) => {
            if (registered) await hold();
            return candidates(...args);
          },
        );
      },
    });
    expect(out.ends).toHaveLength(1);
    expect(out.ends[0]).toMatchObject({
      outcome: 'ok',
      delivered: 'full',
      granted: 'used',
      ref: 'ref-ingest',
    });
    expect(out.docs).toHaveLength(1);
    expect(out.laterCalls.length).toBeGreaterThan(0);
    expect(new Set(out.laterCalls.map((e) => e.job?.ref))).toEqual(
      new Set(['ref-ingest']),
    );
  });

  test('a saved scope that is invalid fails the ingest before any work, never ok with no grant', async () => {
    const calls = modelCalls();
    const ends: JobEnd[] = [];
    const a = app({
      admission: allowWithRef,
      backgroundScope: () =>
        Promise.resolve({ budget: { tokens: -5 } } as never),
      onJobEnd: (e) => void ends.push(e),
    });
    const res = await call(a, '/api/ingest', { body: { url } });
    expect(res.status).toBe(500);
    await sleep(100);
    expect(calls()).toBe(0);
    expect(await env.registry.list()).toEqual([]);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: 'failed', delivered: 'none' });
  });
});

describe('a restored scope and a new grant', () => {
  test('are added exactly once: the saved remaining amount plus the grant', async () => {
    const docId = await ingestDoc(app()); // an earlier process
    const budgets: (number | undefined)[] = [];
    const original = provider.generateObject.bind(provider);
    vi.spyOn(provider, 'generateObject').mockImplementation((req) => {
      if (req.schemaName === 'section_briefs')
        budgets.push(currentJob()?.budget?.tokens);
      return original(req);
    });
    const a = app({
      admission: (_c, job) =>
        Promise.resolve({
          allow: true,
          ...(job.kind === 'ingest' ? { budget: { tokens: 30 } } : {}),
        }),
      // The host saved 30 tokens remaining, NOT counting the grant being admitted.
      backgroundScope: () => Promise.resolve({ budget: { tokens: 30 } }),
    });
    await ingestDoc(a, 'bob');
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(() => {
      expect(budgets.length).toBeGreaterThan(0);
    });
    expect(budgets[0]).toBe(60);
  });
});

describe('attribution when a top-up lands during a call', () => {
  test('a call in flight is reported under the ref it started with', async () => {
    env.serve(url, manyParts(40), 'text/plain');
    const usage: UsageEvent[] = [];
    const a = app({
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
      admission: (c, job) =>
        Promise.resolve({
          allow: true,
          ref: `ref-${c.req.header('x-reader') ?? ''}`,
          ...(job.kind === 'ingest'
            ? {
                budget: {
                  tokens: c.req.header('x-reader') === 'alice' ? 60 : 1e9,
                },
              }
            : {}),
        }),
      backgroundScope: () => Promise.resolve(undefined),
      onUsage: (e) => void usage.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    provider.gate = () => (++calls === 2 ? gate : Promise.resolve());
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(() => {
      expect(calls).toBe(2);
    });
    // Bob pays while alice's second batch is in the model's hands.
    await ingestDoc(a, 'bob');
    release();
    await vi.waitFor(
      async () => {
        const r = (await (
          await call(a, `/api/docs/${docId}/breakdown`)
        ).json()) as { status: string };
        expect(r.status).toBe('cached');
      },
      { timeout: 20_000 },
    );
    const refs = usage
      .filter((e) => e.feature === 'breakdown')
      .map((e) => e.job?.ref);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    expect(refs.slice(0, 2)).toEqual(['ref-alice', 'ref-alice']);
    expect(new Set(refs.slice(2))).toEqual(new Set(['ref-bob']));
  }, 40_000);
});

describe('a restored scope counts a grant once, whoever credits what and when', () => {
  test('a host that credits its ledger when the ingest ends ok is not consulted after its own credit', async () => {
    const docId = await ingestDoc(app()); // an earlier process
    const budgets: (number | undefined)[] = [];
    const original = provider.generateObject.bind(provider);
    vi.spyOn(provider, 'generateObject').mockImplementation((req) => {
      if (req.schemaName === 'section_briefs')
        budgets.push(currentJob()?.budget?.tokens);
      return original(req);
    });
    const ledger = { remaining: 30 };
    const order: string[] = [];
    const a = app({
      admission: (_c, job) =>
        Promise.resolve({
          allow: true,
          ref: 'ref-bob',
          ...(job.kind === 'ingest' ? { budget: { tokens: 30 } } : {}),
        }),
      backgroundScope: () => {
        order.push(`lookup ${String(ledger.remaining)}`);
        return Promise.resolve({ budget: { tokens: ledger.remaining } });
      },
      onJobEnd: async (end) => {
        order.push(`end ${end.outcome}`);
        await sleep(1);
        // The natural bookkeeping: the grant joins the ledger when the job ends ok.
        if (end.outcome === 'ok') ledger.remaining += 30;
      },
    });
    await ingestDoc(a, 'bob');
    await call(a, `/api/docs/${docId}/breakdown`);
    await vi.waitFor(() => {
      expect(budgets.length).toBeGreaterThan(0);
    });
    expect(order).toEqual(['lookup 30', 'end ok']);
    expect(budgets[0]).toBe(60);
  });

  test("a reader's generating request waiting on the host does not take the payer's grant", async () => {
    env.serve(url, manyParts(40), 'text/plain');
    const docId = await ingestDoc(app()); // an earlier process
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const budgets: (number | undefined)[] = [];
    const original = provider.generateObject.bind(provider);
    vi.spyOn(provider, 'generateObject').mockImplementation((req) => {
      if (req.schemaName === 'section_briefs')
        budgets.push(currentJob()?.budget?.tokens);
      return original(req);
    });
    const a = app({
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
      admission: (c, job) =>
        Promise.resolve({
          allow: true,
          ref: `ref-${c.req.header('x-reader') ?? ''}`,
          ...(job.kind === 'ingest' ? { budget: { tokens: 1e6 } } : {}),
        }),
      backgroundScope: async () => {
        asked++;
        await gate;
        return { budget: { tokens: 30 } };
      },
    });
    // Carol's generating request starts waiting on the host first; then bob pays.
    const carol = call(a, `/api/docs/${docId}/breakdown`, { reader: 'carol' });
    await vi.waitFor(() => {
      expect(asked).toBe(1);
    });
    const bob = ingestDoc(a, 'bob');
    await sleep(100);
    release();
    await Promise.all([carol, bob]);
    await vi.waitFor(
      async () => {
        const r = (await (
          await call(a, `/api/docs/${docId}/breakdown`, { reader: 'bob' })
        ).json()) as { status: string; briefs?: unknown[] };
        expect(r.status).toBe('cached');
        expect(r.briefs).toHaveLength(40);
      },
      { timeout: 20_000 },
    );
    expect(Math.max(...budgets.map((b) => b ?? 0))).toBeGreaterThanOrEqual(
      1_000_000,
    );
  }, 40_000);
});

describe('a payer never waits behind a refusal that landed after they paid', () => {
  test("carol's zero-budget generating requests in the install window do not cool down bob's tier", async () => {
    env.serve(url, manyParts(40), 'text/plain');
    const docId = await ingestDoc(app()); // an earlier process
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let asked = 0;
    const a = app({
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
      admission: (c, job) =>
        Promise.resolve({
          allow: true,
          ref: `ref-${c.req.header('x-reader') ?? ''}`,
          ...(job.kind === 'ingest' ? { budget: { tokens: 1e9 } } : {}),
        }),
      // The host knows nothing about this document yet.
      backgroundScope: async () => {
        asked++;
        await gate;
        return undefined;
      },
    });
    const carol = Promise.all([
      call(a, `/api/docs/${docId}/summary`, { reader: 'carol' }),
      call(a, `/api/docs/${docId}/breakdown`, { reader: 'carol' }),
    ]);
    await vi.waitFor(() => {
      expect(asked).toBe(1);
    });
    const bob = ingestDoc(a, 'bob');
    await sleep(100);
    release();
    await Promise.all([carol, bob]);
    // No clock moves: the payer is served now, not after a cool-down meant for a refusal.
    for (const path of ['summary', 'breakdown'])
      await vi.waitFor(
        async () => {
          const r = (await (
            await call(a, `/api/docs/${docId}/${path}`, { reader: 'bob' })
          ).json()) as { status: string };
          expect(r.status).toBe('cached');
        },
        { timeout: 20_000 },
      );
  }, 60_000);
});

describe('a grant in another unit', () => {
  const scope = (
    budget: JobScope['budget'],
    extra: Partial<JobScope> = {},
  ): JobScope => ({
    context: { readerId: 'r', jobKind: 'ingest', jobId: 'j', ref: 'r1' },
    budget,
    models: { answer: 'tier-a' },
    prices: PRICES,
    spent: newSpend(),
    ...extra,
  });

  test('units that match are summed', () => {
    const live = scope({ tokens: 30 });
    addBudget(live, scope({ tokens: 20 }));
    expect(live.budget).toEqual({ tokens: 50 });
  });

  test('a dollars grant is never capped by the old token ceiling', () => {
    const live = scope({ tokens: 1_000_000 });
    live.spent.tokens = 400_000;
    live.spent.lastModel = 'tier-a';
    const paid = scope({ dollars: 5 });
    paid.context.ref = 'bob';
    addBudget(live, paid);
    // 600,000 tokens left at $1/MTok is $0.60, plus the $5 grant; spending starts again from zero.
    expect(live.budget?.tokens).toBeUndefined();
    expect(live.budget?.dollars).toBeCloseTo(5.6, 6);
    expect(live.spent.tokens).toBe(0);
    expect(live.context.ref).toBe('bob');
  });

  test('with no price for the model the grant replaces the old ceiling', () => {
    const live = scope({ tokens: 30 }, { models: { answer: 'unpriced' } });
    addBudget(live, scope({ dollars: 5 }));
    expect(live.budget).toEqual({ dollars: 5 });
  });
});

describe('review: reuse path, unused grants, scope epoch stamps', () => {
  test('A5: a disk error after touch on the reused-document path fails the job with no grant', async () => {
    await ingestDoc(app()); // already registered and indexed
    let touched = false;
    const touch = env.registry.touch.bind(env.registry);
    vi.spyOn(env.registry, 'touch').mockImplementation(async (...args) => {
      const entry = await touch(...args);
      touched = true;
      return entry;
    });
    const getDocument = env.registry.getDocument.bind(env.registry);
    let failing = true;
    vi.spyOn(env.registry, 'getDocument').mockImplementation((...args) =>
      touched && failing
        ? Promise.reject(new Error('disk error'))
        : getDocument(...args),
    );
    const ends: JobEnd[] = [];
    const usage: UsageEvent[] = [];
    const a = app({
      admission: allowWithRef,
      onUsage: (e) => void usage.push(e),
      onJobEnd: (e) => void ends.push(e),
    });
    const text = await (await call(a, '/api/ingest', { body: { url } })).text();
    expect(text).toContain('"type":"error"');
    expect(text).not.toContain('"type":"done"');
    await sleep(100);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ outcome: 'failed', delivered: 'none' });
    failing = false;
    const docId = (await env.registry.list())[0]?.docId ?? '';
    await call(a, `/api/docs/${docId}/summary`);
    await sleep(600);
    // No grant was installed: nothing runs under the failed admission's ref.
    expect(usage).toEqual([]);
  });

  test('an unused grant is not added to the live scope', async () => {
    const budgets: (number | undefined)[] = [];
    const refs: (string | undefined)[] = [];
    const ends: JobEnd[] = [];
    const a = app({
      pregenerateExamples: 'off',
      admission: (c, job) =>
        Promise.resolve({
          allow: true,
          ref: `ref-${c.req.header('x-reader') ?? ''}`,
          ...(job.kind === 'ingest'
            ? {
                budget: {
                  tokens:
                    c.req.header('x-reader') === 'alice' ? 5_000_000 : 1e9,
                },
              }
            : {}),
        }),
      backgroundScope: () => Promise.resolve(undefined),
      onJobEnd: (e) => void ends.push(e),
    });
    const docId = await ingestDoc(a, 'alice');
    const get = async (path: string) =>
      (await (await call(a, `/api/docs/${docId}/${path}`)).json()) as {
        status: string;
      };
    await vi.waitFor(async () => {
      expect((await get('summary')).status).toBe('cached');
    });
    await vi.waitFor(async () => {
      expect((await get('breakdown')).status).toBe('cached');
    });
    for (const p of ['summary/pictures', 'breakdown/pictures'])
      await vi.waitFor(async () => {
        expect((await get(p)).status).toMatch(/cached|none/);
      });
    await ingestDoc(a, 'bob');
    expect(ends.find((e) => e.ref === 'ref-bob')).toMatchObject({
      outcome: 'ok',
      granted: 'unused',
    });
    // Make the summary generate again, and see which budget it runs under.
    await rm(join(env.registry.configDir, 'cache'), {
      recursive: true,
      force: true,
    });
    const original = provider.generateObject.bind(provider);
    vi.spyOn(provider, 'generateObject').mockImplementation((req) => {
      budgets.push(currentJob()?.budget?.tokens);
      refs.push(currentJob()?.context.ref);
      return original(req);
    });
    const originalStream = provider.streamText.bind(provider);
    vi.spyOn(provider, 'streamText').mockImplementation((req) => {
      budgets.push(currentJob()?.budget?.tokens);
      refs.push(currentJob()?.context.ref);
      return originalStream(req);
    });
    await get('summary');
    await vi.waitFor(() => {
      expect(budgets.length).toBeGreaterThan(0);
    });
    expect(new Set(budgets)).toEqual(new Set([5_000_000]));
    expect(new Set(refs)).toEqual(new Set(['ref-alice']));
  }, 40_000);

  test('a refusal by a scope that resolved before the grant does not cool the payer down, however late it lands', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    env.runtime.providerFor = (_role, model) => {
      const p = breakdownProvider(scenarioProvider(new MockProvider(model)));
      p.behavior = () => {
        throw new AppError('PROVIDER_ERROR', 'down');
      };
      return p;
    };
    const service = createBreakdownService(routedRuntime(env.runtime), {
      publicMode: false,
      waitMs: 20,
      pregenerateExamples: 'off',
    });
    const models = { answer: 'stamp-a', extract: 'stamp-a' };
    const tier = tierName(models);
    // The scope was handed out at epoch k; then someone paid (k + 1); then the run begins.
    const before = grantEpoch(docId, tier);
    bumpGrantEpoch(docId, tier);
    const refused: JobScope = {
      context: { readerId: 'carol', jobKind: 'ingest', jobId: 'c', docId },
      models,
      epoch: before,
      spent: newSpend(),
    };
    await runInJob(refused, () => service.get(docId, { wait: false }));
    // Its failure is recorded after the grant but belongs to the epoch before it.
    await sleep(300);
    const payer: JobScope = {
      context: { readerId: 'bob', jobKind: 'ingest', jobId: 'b', docId },
      models,
      spent: newSpend(),
    };
    await expect(
      runInJob(payer, () => service.get(docId, { wait: false })),
    ).resolves.toMatchObject({ status: 'pending' });
  });
});
