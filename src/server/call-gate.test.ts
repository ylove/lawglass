/** The per-call spend gate across every feature that calls a model (issue #435). */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Hono } from 'hono';
import { breakdownProvider } from '../../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { scenarioProvider } from '../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import type { CallEnd, GateCall, UsageEvent } from '../core/cost/index.js';
import { MockProvider } from '../core/llm/mock.js';
import { IngestEvent, type LlmProvider } from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import { createApp, type AppOptions, type ExternalAuth } from './app.js';

const url = 'https://govinfo.gov/a.txt';
let env: PipelineEnv;
/** Every call that reached a provider, and how many gate calls had been made before each. */
let reached: { gatesBefore: number }[];
let gates: GateCall[];
let usage: UsageEvent[];
let ends: CallEnd[];

const auth: ExternalAuth = {
  middleware: async (c, next) =>
    c.req.header('x-reader') ? next() : c.text('Sign in', 401),
  readerId: (c) => c.req.header('x-reader') ?? 'nobody',
};

/** Outermost wrapper: counts what actually reaches a model. */
function counting(base: LlmProvider): LlmProvider {
  const note = () => reached.push({ gatesBefore: gates.length });
  return {
    id: base.id,
    model: base.model,
    streamText: (req) => {
      note();
      return base.streamText(req);
    },
    generateObject: (req) => {
      note();
      return base.generateObject(req);
    },
  };
}

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(url, makeSectionedText(), 'text/plain');
  const inner = breakdownProvider(scenarioProvider(env.provider));
  const provider = counting(inner);
  Object.assign(env.runtime, {
    answerProvider: provider,
    extractProvider: provider,
    providerFor: () => provider,
  });
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), 'small');
  resetSharedLimits();
  reached = [];
  gates = [];
  usage = [];
  ends = [];
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 60));
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetSharedLimits();
  await env.cleanup();
});

const RATE = { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 };
const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, {
    auth,
    admission: () => Promise.resolve({ allow: true, ref: 'hold-1' }),
    backgroundScope: () => Promise.resolve(undefined),
    logWriter: () => undefined,
    summaryWaitMs: 20,
    ...options,
    quote: { prices: { deterministic: RATE, [MockProvider.name]: RATE } },
  });
const call = (a: Hono, path: string, body?: unknown) =>
  a.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-reader': 'alice', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
async function ingestDoc(a: Hono): Promise<string> {
  const res = await call(a, '/api/ingest', { url });
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}
const json = async (res: Response) => (await res.json()) as { status: string };

describe('a per-call gate sees every model call exactly once', () => {
  test('ingest, summary, breakdown, pictures, examples, questions, chips, locate and scenarios', async () => {
    const a = app({
      spendGate: (c: GateCall) => {
        gates.push(c);
        return true;
      },
      onUsage: (e) => {
        usage.push(e);
      },
      onCallEnd: (e) => {
        ends.push(e);
      },
    });
    const docId = await ingestDoc(a);
    const doc = `/api/docs/${docId}`;
    // Background generation, started by reading each part.
    for (const path of [
      'summary',
      'breakdown',
      'summary/pictures',
      'breakdown/pictures',
    ])
      await vi.waitFor(async () => {
        const r = await json(await call(a, `${doc}/${path}`));
        expect(['cached', 'ok', 'none', 'disabled']).toContain(r.status);
      });
    // A typed question that asks for a story, a chip, locate, a subject scenario and a section example.
    await (
      await call(a, `${doc}/ask`, {
        question: 'Show me an example of what this means for a farmer.',
      })
    ).text();
    await (await call(a, `${doc}/ask`, { chipId: 'who-affected' })).text();
    await call(a, `${doc}/locate`, {
      text: 'The department shall publish a rule.',
    });
    await call(a, `${doc}/scenario`, { subject: 'a farmer' });
    await vi.waitFor(async () => {
      expect(
        (await json(await call(a, `${doc}/sections/sec-2/example`))).status,
      ).toBe('ok');
    });
    await new Promise((r) => setTimeout(r, 200));

    // Several features ran, and each model call was gated exactly once, before it was made.
    expect(reached.length).toBeGreaterThan(6);
    expect(gates.length).toBe(reached.length);
    expect(reached.every((r, i) => r.gatesBefore > i)).toBe(true);
    const ids = gates.map((g) => g.callId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(gates.every((g) => g.ref === 'hold-1' && g.worstCaseUsd > 0)).toBe(
      true,
    );
    expect([...new Set(gates.map((g) => g.jobKind))].sort()).toEqual([
      'ingest',
      'locate',
      'question',
      'scenario',
    ]);
    // Every kind of work went through the same gate.
    const features = new Set(usage.map((u) => u.feature));
    for (const feature of [
      'metadata',
      'summary',
      'breakdown',
      'scenario',
      'question',
      'chip',
      'locate',
    ])
      expect(features, feature).toContain(feature);
    // Usage carries the id of the call it was for; every allowed call ends exactly once.
    expect(usage.length).toBeGreaterThan(0);
    for (const u of usage) expect(ids).toContain(u.callId);
    expect(ends.map((e) => e.callId).sort()).toEqual([...ids].sort());
    const reportedIds = new Set(usage.map((u) => u.callId));
    for (const e of ends) expect(e.reported).toBe(reportedIds.has(e.callId));
  });

  test('a gate that refuses stops every feature before any provider is reached', async () => {
    const a = app({
      spendGate: (c: GateCall) => {
        gates.push(c);
        return false;
      },
    });
    const res = await call(a, '/api/ingest', { url });
    await res.text();
    expect(gates.length).toBeGreaterThan(0);
    expect(reached).toHaveLength(0);
  });
});

describe('zero-parameter hosts are unchanged', () => {
  test('a () => boolean gate is not given a call, and onUsage events still arrive', async () => {
    let asked = 0;
    const a = app({
      spendGate: () => {
        asked += 1;
        return true;
      },
      onUsage: (e) => {
        usage.push(e);
      },
    });
    const docId = await ingestDoc(a);
    await (
      await call(a, `/api/docs/${docId}/ask`, { question: 'Who pays?' })
    ).text();
    expect(asked).toBeGreaterThan(0);
    expect(gates).toHaveLength(0);
    expect(usage.length).toBeGreaterThan(0);
    expect(ends).toHaveLength(0);
  });
});
