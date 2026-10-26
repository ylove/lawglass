import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  breakdownProvider,
  type BreakdownProvider,
} from '../../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { createSessionTestApp as createApp } from '../../tests/support/session-app.js';
import {
  scenarioProvider,
  type ScenarioProvider,
} from '../../tests/support/scenario-provider.js';
import { makeSectionedText } from '../../tests/synth/index.js';
import { envVar } from '../core/brand.js';
import {
  EXAMPLE_FAILED_NOTE,
  NO_EXAMPLE_NOTE,
} from '../core/breakdown/notes.js';
import {
  AppError,
  BreakdownResponse,
  ClientConfig,
  IngestEvent,
  ScenarioResponse,
} from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import type { AppOptions } from './app.js';
import { MAX_PREGENERATED_EXAMPLES } from './breakdown.js';
import { FAILED_RETRY_MS } from './summary.js';

const URL_A = 'https://example.gov/gardens.txt';

let env: PipelineEnv;
let provider: BreakdownProvider & { scen: ScenarioProvider };

/** A bill with `count` substantive sections, each long enough to be a part of its own. */
function manySections(count: number) {
  const lines = ['Synthetic Many Parts Bill'];
  for (let i = 1; i <= count; i++)
    lines.push(
      `Section ${String(i)}. Topic ${String(i)}`,
      `The department shall publish rule number ${String(i)} for each grantee.`,
    );
  lines.push('');
  return { bytes: new TextEncoder().encode(lines.join('\n')) };
}

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(URL_A, makeSectionedText(), 'text/plain');
  const scen = scenarioProvider(env.provider);
  provider = Object.assign(breakdownProvider(scen), { scen });
  Object.assign(env.runtime, { answerProvider: provider });
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '1000');
  // Background pre-generation would outlive a test and race its cleanup; tests that exercise it turn it on.
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
});
afterEach(async () => {
  // A cache write that finishes a beat after the test's last assertion must not race the cleanup.
  await new Promise((resolve) => setTimeout(resolve, 60));
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, { localOnly: false, summaryWaitMs: 20, ...options });

async function ingestDoc(a: Hono, url = URL_A): Promise<string> {
  const res = await a.request('/api/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  for await (const e of readSseEvents(res, IngestEvent))
    if (e.type === 'done') return e.doc.docId;
  throw new Error('ingest did not finish');
}

async function breakdown(a: Hono, docId: string): Promise<BreakdownResponse> {
  const res = await a.request(`/api/docs/${docId}/breakdown`);
  expect(res.status).toBe(200);
  return BreakdownResponse.parse(await res.json());
}

async function example(
  a: Hono,
  docId: string,
  sectionId: string,
): Promise<ScenarioResponse> {
  const res = await a.request(
    `/api/docs/${docId}/sections/${encodeURIComponent(sectionId)}/example`,
  );
  expect(res.status).toBe(200);
  return ScenarioResponse.parse(await res.json());
}

const cachedBreakdown = (a: Hono, docId: string) =>
  vi.waitFor(
    async () => {
      const r = await breakdown(a, docId);
      expect(r.status).toBe('cached');
      return r;
    },
    { timeout: 5000 },
  );

/** Example runs (optionally for one part), not the summary's own bill-level scenario. */
const exampleCalls = (sectionId?: string) =>
  provider.scen.prompts.filter((p) =>
    p.includes(
      sectionId === undefined ? '<focus>' : `<focus>${sectionId}</focus>`,
    ),
  ).length;

describe('config', () => {
  test('breakdownEnabled is true except in public mode', async () => {
    for (const [publicMode, expected] of [
      [false, true],
      [true, false],
    ] as const) {
      const res = await app({ publicMode }).request('/api/config');
      expect(ClientConfig.parse(await res.json()).breakdownEnabled).toBe(
        expected,
      );
    }
  });
});

describe('GET /api/docs/:docId/breakdown', () => {
  test('start:false only reports: it starts no run and skips the cool-down error (#344)', async () => {
    const { createBreakdownService } = await import('./breakdown.js');
    const a = app();
    const docId = await ingestDoc(a);
    const service = createBreakdownService(env.runtime, { publicMode: false });
    expect(await service.get(docId, { wait: false, start: false })).toEqual({
      status: 'disabled',
    });
    // Nothing was in flight: a normal look still has to start the run.
    expect(await service.get(docId, { wait: false })).toEqual({
      status: 'pending',
    });
    expect(
      (await service.get(docId, { wait: false, start: false })).status,
    ).toBe('pending');
  });

  test('the first look starts one run and answers pending; the next is the cached briefs', async () => {
    const a = app({ now: () => Date.now() });
    const docId = await ingestDoc(a);
    expect((await breakdown(a, docId)).status).toBe('pending');
    const done = await cachedBreakdown(a, docId);
    expect(done.briefs?.map((b) => b.sectionId)).toContain('sec-2');
    expect(done.briefs?.[0]?.citations.length).toBeGreaterThan(0);
    expect(done.omitted).toBe(0);
    expect(provider.breakdownCalls).toBe(1);
    // Never the boilerplate parts.
    expect(done.briefs?.map((b) => b.sectionId)).not.toContain('sec-1');
  });

  test('a second look, even from a fresh server, makes no model call', async () => {
    const first = app();
    const docId = await ingestDoc(first);
    await breakdown(first, docId);
    const cached = await cachedBreakdown(first, docId);
    const calls = provider.breakdownCalls;
    expect(await breakdown(app(), docId)).toEqual(cached);
    expect(provider.breakdownCalls).toBe(calls);
    const dir = join(env.registry.configDir, 'cache', 'answers', docId);
    expect((await readdir(dir)).some((f) => f.startsWith('breakdown-'))).toBe(
      true,
    );
  });

  test('concurrent first looks share one run', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    // Hold the model call until all three looks have returned, so none can see a finished run.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    provider.gate = () => held;
    const results = await Promise.all([
      breakdown(a, docId),
      breakdown(a, docId),
      breakdown(a, docId),
    ]);
    release();
    expect(results.map((r) => r.status)).toEqual([
      'pending',
      'pending',
      'pending',
    ]);
    await cachedBreakdown(a, docId);
    expect(provider.breakdownCalls).toBe(1);
  });

  test('shows the parts finished so far while the run is still going', async () => {
    const a = app();
    const docId = await ingestDoc(a, URL_MANY());
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    provider.gate = async () => {
      if (++calls === 2) await held;
    };
    await breakdown(a, docId);
    const partial = await vi.waitFor(async () => {
      const r = await breakdown(a, docId);
      expect(r.status).toBe('pending');
      expect(r.briefs?.length).toBe(10);
      return r;
    });
    expect(partial.briefs?.[0]?.sectionId).toBe('sec-1');
    release();
    const done = await cachedBreakdown(a, docId);
    expect(done.briefs).toHaveLength(12);
  });

  test('waits for the summary rather than competing with it', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stream = env.provider.streamText.bind(env.provider);
    vi.spyOn(provider, 'streamText').mockImplementation(async function* (req) {
      await held;
      yield* stream(req);
    });
    await breakdown(a, docId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(provider.breakdownCalls).toBe(0);
    release();
    await cachedBreakdown(a, docId);
    expect(provider.breakdownCalls).toBe(1);
  });

  test('a failed run backs off as an error the client can retry, then allows one new attempt', async () => {
    let now = Date.UTC(2026, 9, 14);
    provider.behavior = () => {
      throw new Error('boom');
    };
    const a = app({ now: () => now });
    const docId = await ingestDoc(a);
    expect((await breakdown(a, docId)).status).toBe('pending');
    // Not `disabled`: that would hide the panel and the parts a reader was already reading.
    const failure = await vi.waitFor(async () => {
      const res = await a.request(`/api/docs/${docId}/breakdown`);
      expect(res.status).toBe(500);
      return (await res.json()) as { error: { code: string; message: string } };
    });
    expect(failure.error.code).toBe('PROVIDER_ERROR');
    expect(failure.error.message).toMatch(/try again/i);
    expect(provider.breakdownCalls).toBe(1);
    for (let i = 0; i < 3; i++) await a.request(`/api/docs/${docId}/breakdown`);
    expect(provider.breakdownCalls).toBe(1);

    provider.behavior = undefined;
    now += FAILED_RETRY_MS + 1;
    expect((await breakdown(a, docId)).status).toBe('pending');
    await cachedBreakdown(a, docId);
    expect(provider.breakdownCalls).toBe(2);
  });

  test('public mode serves only what is cached and never starts a run', async () => {
    const owner = app();
    const docId = await ingestDoc(owner);
    const publicApp = app({ publicMode: true });
    expect(await breakdown(publicApp, docId)).toEqual({ status: 'disabled' });
    expect(provider.breakdownCalls).toBe(0);

    await breakdown(owner, docId);
    const cached = await cachedBreakdown(owner, docId);
    const calls = provider.breakdownCalls;
    expect(await breakdown(publicApp, docId)).toEqual(cached);
    expect(provider.breakdownCalls).toBe(calls);
  });

  test('a bill that is all boilerplate has nothing to brief', async () => {
    env.serve(
      'https://example.gov/short.txt',
      {
        bytes: new TextEncoder().encode(
          'Tiny Bill\nSection 1. Short title\nThis act may be cited as the Tiny Act.\n',
        ),
      },
      'text/plain',
    );
    const a = app();
    const docId = await ingestDoc(a, 'https://example.gov/short.txt');
    expect(await breakdown(a, docId)).toEqual({ status: 'disabled' });
    expect(provider.breakdownCalls).toBe(0);
  });

  test('an unknown document is a 404, and a cross-site request is refused', async () => {
    const a = app();
    expect(
      (await a.request(`/api/docs/${'0'.repeat(64)}/breakdown`)).status,
    ).toBe(404);
    const docId = await ingestDoc(a);
    for (const path of [
      `/api/docs/${docId}/breakdown`,
      `/api/docs/${docId}/sections/sec-2/example`,
    ]) {
      const res = await a.request(path, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(res.status).toBe(403);
    }
    expect(provider.breakdownCalls).toBe(0);
  });
});

function URL_MANY(): string {
  const url = 'https://example.gov/many.txt';
  env.serve(url, manySections(12), 'text/plain');
  return url;
}

describe('GET /api/docs/:docId/sections/:sectionId/example', () => {
  test('starts generation for that part, answers pending, then the example', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    expect((await example(a, docId, 'sec-2')).status).toBe('pending');
    const done = await vi.waitFor(
      async () => {
        const r = await example(a, docId, 'sec-2');
        expect(r.status).toBe('ok');
        return r;
      },
      { timeout: 5000 },
    );
    expect(done.scenario?.frames.length).toBeGreaterThanOrEqual(3);
    expect(done.scenario?.profile.illustrative).toBe(true);
    // Asking again is free, and the prompt carried the part's id.
    expect(exampleCalls('sec-2')).toBe(1);
    await example(a, docId, 'sec-2');
    expect(exampleCalls('sec-2')).toBe(1);
  });

  test('a part whose brief said there is nothing to show answers none with our note, with no model call', async () => {
    provider.noExample.add('sec-2');
    const a = app();
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    expect(await example(a, docId, 'sec-2')).toEqual({
      status: 'none',
      note: NO_EXAMPLE_NOTE,
    });
    expect(exampleCalls('sec-2')).toBe(0);
  });

  test('an example the validator rejects is a cached none with our note, not retried at once', async () => {
    provider.scen.behavior = () =>
      Promise.resolve({
        object: { not: 'a scenario' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as never;
    const a = app();
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    await example(a, docId, 'sec-2');
    await vi.waitFor(async () => {
      expect(await example(a, docId, 'sec-2')).toEqual({
        status: 'none',
        note: EXAMPLE_FAILED_NOTE,
      });
    });
    const calls = exampleCalls('sec-2');
    for (let i = 0; i < 3; i++) await example(a, docId, 'sec-2');
    expect(exampleCalls('sec-2')).toBe(calls);
  });

  test('a provider failure is not a none: it is an error, never cached, and works again once it recovers', async () => {
    let now = Date.UTC(2026, 9, 14);
    provider.scen.behavior = () =>
      Promise.reject(new AppError('RATE_LIMITED', 'limit'));
    const a = app({ now: () => now });
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    await example(a, docId, 'sec-2');
    const failure = await vi.waitFor(async () => {
      const res = await a.request(`/api/docs/${docId}/sections/sec-2/example`);
      expect(res.status).toBe(500);
      return (await res.json()) as { error: { code: string; message: string } };
    });
    expect(failure.error.message).toBe(
      "Couldn't draw an example right now. Try again.",
    );
    // Well past the none cool-down, with the provider back: a real example, not a stale none.
    provider.scen.behavior = undefined;
    now += 11 * 60_000;
    await example(a, docId, 'sec-2');
    const done = await vi.waitFor(async () => {
      const r = await example(a, docId, 'sec-2');
      expect(r.status).toBe('ok');
      return r;
    });
    expect(done.scenario).toBeDefined();
  });

  test('an unknown part is a 404 and costs nothing', async () => {
    const a = app();
    const docId = await ingestDoc(a);
    const res = await a.request(`/api/docs/${docId}/sections/sec-1/example`);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_INPUT',
    );
    expect(exampleCalls()).toBe(0);
  });

  test('public mode serves a cached example but never starts one', async () => {
    const owner = app();
    const docId = await ingestDoc(owner);
    const publicApp = app({ publicMode: true });
    expect(await example(publicApp, docId, 'sec-2')).toEqual({
      status: 'disabled',
    });
    expect(exampleCalls()).toBe(0);

    await breakdown(owner, docId);
    await cachedBreakdown(owner, docId);
    await vi.waitFor(async () => {
      expect((await example(owner, docId, 'sec-2')).status).toBe('ok');
    });
    expect((await example(publicApp, docId, 'sec-2')).status).toBe('ok');
  });
});

describe('pre-generation', () => {
  /** Tracks how many example generations overlap. */
  function trackConcurrency() {
    const state = { active: 0, peak: 0, started: [] as string[] };
    const generate = provider.generateObject.bind(provider);
    provider.generateObject = async (req) => {
      const focus = /<focus>([^<]+)<\/focus>/.exec(
        JSON.stringify(req.prompt),
      )?.[1];
      if (!focus) return generate(req);
      state.started.push(focus);
      state.active++;
      state.peak = Math.max(state.peak, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return await generate(req);
      } finally {
        state.active--;
      }
    };
    return state;
  }

  test('a report-only look at a cached breakdown never starts drawing examples (#352 review)', async () => {
    const { createBreakdownService } = await import('./breakdown.js');
    const state = trackConcurrency();
    const a = app();
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    const done = await cachedBreakdown(a, docId);
    const available =
      done.briefs?.filter((b) => b.example === 'available').length ?? 0;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // A fresh process (as after a restart) has not drawn this document's examples yet.
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    const service = createBreakdownService(env.runtime, { publicMode: false });
    const before = state.started.length;
    expect(
      (await service.get(docId, { wait: false, start: false })).status,
    ).toBe('cached');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.started).toHaveLength(before);
    // The same look without start:false does start them, so the check above can fail. Let
    // the pass finish, so no example is still writing when the test's directory is removed.
    await service.get(docId, { wait: false });
    await vi.waitFor(
      () => {
        expect(state.started).toHaveLength(before + available);
        expect(state.active).toBe(0);
      },
      { timeout: 10_000 },
    );
    expect(available).toBeGreaterThan(0);
  });

  test('a bill with more than the bound of available examples draws them on demand only', async () => {
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    const state = trackConcurrency();
    const a = app();
    const docId = await ingestDoc(a, URL_MANY());
    await breakdown(a, docId);
    const done = await cachedBreakdown(a, docId);
    const available =
      done.briefs?.filter((b) => b.example === 'available') ?? [];
    expect(available.length).toBe(12);
    // 12 available is over the bound: nothing is pre-generated.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.started).toEqual([]);
  });

  test('with at most 8 available it draws them all, sequentially, in document order', async () => {
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    const state = trackConcurrency();
    env.serve(
      'https://example.gov/eight.txt',
      manySections(MAX_PREGENERATED_EXAMPLES),
      'text/plain',
    );
    const a = app();
    const docId = await ingestDoc(a, 'https://example.gov/eight.txt');
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    await vi.waitFor(
      () => {
        expect(state.started).toHaveLength(MAX_PREGENERATED_EXAMPLES);
      },
      { timeout: 5000 },
    );
    await vi.waitFor(() => {
      expect(state.active).toBe(0);
    });
    expect(state.peak).toBe(1);
    expect(state.started).toEqual(
      Array.from(
        { length: MAX_PREGENERATED_EXAMPLES },
        (_, i) => `sec-${String(i + 1)}`,
      ),
    );
    // Every one is now instant. The pass caches an example only after its model call returns, so
    // on a slow runner the last one can still read `pending`: wait for it to land first.
    const calls = exampleCalls();
    const last = `sec-${String(MAX_PREGENERATED_EXAMPLES)}`;
    await vi.waitFor(
      async () => {
        expect((await example(a, docId, last)).status).toBe('ok');
      },
      { timeout: 5000 },
    );
    for (let i = 1; i <= MAX_PREGENERATED_EXAMPLES; i++)
      expect((await example(a, docId, `sec-${String(i)}`)).status).toBe('ok');
    expect(exampleCalls()).toBe(calls);
  });

  test('the pass stops at the first real failure', async () => {
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    provider.scen.behavior = () =>
      Promise.reject(new AppError('RATE_LIMITED', 'limit'));
    env.serve('https://example.gov/five.txt', manySections(5), 'text/plain');
    const a = app();
    const docId = await ingestDoc(a, 'https://example.gov/five.txt');
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    await vi.waitFor(() => {
      expect(exampleCalls()).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(exampleCalls()).toBe(1);
  });

  test('a finished pass is not repeated when the breakdown is viewed again, even past a none cool-down', async () => {
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    let now = Date.UTC(2026, 9, 14);
    provider.scen.behavior = () =>
      Promise.resolve({
        object: { not: 'a scenario' },
        usage: { inputTokens: 1, outputTokens: 1 },
      }) as never;
    env.serve('https://example.gov/three.txt', manySections(3), 'text/plain');
    const a = app({ now: () => now });
    const docId = await ingestDoc(a, 'https://example.gov/three.txt');
    await breakdown(a, docId);
    await cachedBreakdown(a, docId);
    // Each part is tried (twice per part: the generator retries rejected output once).
    await vi.waitFor(() => {
      expect(exampleCalls('sec-3')).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const calls = exampleCalls();
    for (let view = 0; view < 3; view++) {
      now += 11 * 60_000;
      await breakdown(a, docId);
      // A new app instance in the same process must not repeat the pass either.
      await breakdown(app({ now: () => now }), docId);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exampleCalls()).toBe(calls);
  });

  test('excerpt mode never pre-generates', async () => {
    vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '1');
    const state = trackConcurrency();
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0');
    const a = app();
    const docId = await ingestDoc(a);
    await breakdown(a, docId);
    const done = await cachedBreakdown(a, docId);
    expect(done.briefs?.length).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(state.started).toEqual([]);
  });
});
