/** Full-coverage mode (#382): the cap, progress, resuming, the 'all' example pass and budgets. */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  breakdownProvider,
  listedIds,
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
import { envVar } from '../core/brand.js';
import {
  AppError,
  BreakdownResponse,
  IngestEvent,
  ScenarioResponse,
} from '../core/model/index.js';
import { resetSharedLimits } from '../core/pipeline/limits.js';
import { readSseEvents } from '../web/sse.js';
import type { AppOptions } from './app.js';
import { MAX_EXAMPLE_FAILURES } from './breakdown.js';
import { FAILED_RETRY_MS } from './summary.js';

let env: PipelineEnv;
let provider: BreakdownProvider & { scen: ScenarioProvider };

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

const budgetError = (): AppError =>
  Object.defineProperty(new AppError('RATE_LIMITED', 'budget'), 'code', {
    value: 'BUDGET_EXHAUSTED',
  });

beforeEach(async () => {
  env = await makePipelineEnv();
  const scen = scenarioProvider(env.provider);
  provider = Object.assign(breakdownProvider(scen), { scen });
  Object.assign(env.runtime, { answerProvider: provider });
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '100000');
  vi.stubEnv(envVar('PREGENERATE_EXAMPLES'), '0');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

const app = (options: AppOptions = {}): Hono =>
  createApp(env.runtime, { localOnly: false, summaryWaitMs: 20, ...options });

async function ingestMany(a: Hono, count: number): Promise<string> {
  const url = `https://example.gov/many-${String(count)}.txt`;
  env.serve(url, manySections(count), 'text/plain');
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

const until = (
  a: Hono,
  docId: string,
  status: BreakdownResponse['status'],
  timeout = 8000,
) =>
  vi.waitFor(
    async () => {
      const r = await breakdown(a, docId);
      expect(r.status).toBe(status);
      return r;
    },
    { timeout },
  );

async function example(a: Hono, docId: string, id: string) {
  const res = await a.request(
    `/api/docs/${docId}/sections/${encodeURIComponent(id)}/example`,
  );
  return ScenarioResponse.parse(await res.json());
}

const exampleCalls = () =>
  provider.scen.prompts.filter((p) => p.includes('<focus>')).length;

describe('the unit cap', () => {
  test('the default keeps 30 briefs and reports the rest as omitted', async () => {
    const a = app();
    const docId = await ingestMany(a, 36);
    await breakdown(a, docId);
    const done = await until(a, docId, 'cached');
    expect(done.briefs).toHaveLength(30);
    expect(done.omitted).toBe(6);
  });

  test("'all' briefs every part, in document order, with a part past 30 open to an example", async () => {
    const a = app({ breakdownMaxUnits: 'all' });
    const docId = await ingestMany(a, 36);
    await breakdown(a, docId);
    const done = await until(a, docId, 'cached');
    expect(done.briefs?.map((b) => b.sectionId)).toEqual(
      Array.from({ length: 36 }, (_, i) => `sec-${String(i + 1)}`),
    );
    expect(done.omitted).toBe(0);
    expect((await example(a, docId, 'sec-36')).status).toBe('pending');
  });

  test('the environment variable sets it, and the option wins over it', async () => {
    vi.stubEnv(envVar('BREAKDOWN_MAX_UNITS'), '33');
    const a = app();
    const docId = await ingestMany(a, 36);
    await breakdown(a, docId);
    expect((await until(a, docId, 'cached')).briefs).toHaveLength(33);
    // A different cap is a different breakdown: the 33-part one is not served for 'all'.
    const b = app({ breakdownMaxUnits: 'all' });
    expect((await breakdown(b, docId)).status).toBe('pending');
    expect((await until(b, docId, 'cached')).briefs).toHaveLength(36);
  });
});

describe('progressive breakdown', () => {
  test('each batch is written as it finishes and the response says how far along it is', async () => {
    const a = app({ breakdownMaxUnits: 'all' });
    const docId = await ingestMany(a, 25);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    provider.gate = async () => {
      if (++calls === 3) await held;
    };
    expect((await breakdown(a, docId)).status).toBe('pending');
    const partial = await vi.waitFor(async () => {
      const r = await breakdown(a, docId);
      expect(r.status).toBe('partial');
      expect(r.briefs).toHaveLength(20);
      return r;
    });
    expect(partial.progress).toEqual({ done: 20, total: 25 });
    // On disk too, so a restart or a report-only look sees the same batches.
    const files = await readdir(
      join(env.runtime.registry.configDir, 'cache', 'answers', docId),
    );
    expect(files.some((f) => f.startsWith('breakdown-partial-'))).toBe(true);
    release();
    const done = await until(a, docId, 'cached');
    expect(done.briefs).toHaveLength(25);
    expect(done.progress).toBeUndefined();
    // The checkpoint is removed just after the final write lands.
    await vi.waitFor(async () => {
      const after = await readdir(
        join(env.runtime.registry.configDir, 'cache', 'answers', docId),
      );
      expect(after.some((f) => f.startsWith('breakdown-partial-'))).toBe(false);
    });
  });

  test('a run that failed midway resumes with the parts already written', async () => {
    let now = Date.UTC(2026, 9, 14);
    const a = app({ breakdownMaxUnits: 'all', now: () => now });
    const docId = await ingestMany(a, 25);
    const reply = provider.behavior;
    let calls = 0;
    provider.behavior = (req) => {
      if (++calls === 3) throw new Error('boom');
      return reply
        ? reply(req)
        : {
            briefs: listedIds(req.prompt).map((id) => ({
              id,
              text: `This part sets rules for ${id}. [S:${id}]`,
              example: 'available',
            })),
          };
    };
    await breakdown(a, docId);
    await vi.waitFor(async () => {
      const res = await a.request(`/api/docs/${docId}/breakdown`);
      expect(res.status).toBe(500);
    });
    provider.behavior = undefined;
    provider.requests.length = 0;
    now += FAILED_RETRY_MS + 1000;
    await breakdown(a, docId);
    const done = await until(a, docId, 'cached');
    expect(done.briefs).toHaveLength(25);
    // Only the five parts that had no brief yet were sent.
    const sent = provider.requests.flatMap((r) => listedIds(r.prompt));
    expect(sent).toEqual(
      Array.from({ length: 5 }, (_, i) => `sec-${String(i + 21)}`),
    );
  });

  test('a spent budget ends the run cleanly: the batches stay, stoppedReason is reported, nothing restarts', async () => {
    const a = app({ breakdownMaxUnits: 'all' });
    const docId = await ingestMany(a, 25);
    let calls = 0;
    provider.behavior = (req) => {
      if (++calls === 3) throw budgetError();
      return {
        briefs: listedIds(req.prompt).map((id) => ({
          id,
          text: `This part sets rules for ${id}. [S:${id}]`,
          example: 'available',
        })),
      };
    };
    await breakdown(a, docId);
    const stopped = await vi.waitFor(async () => {
      const r = await breakdown(a, docId);
      expect(r.progress?.stoppedReason).toBe('budget_exhausted');
      return r;
    });
    expect(stopped.status).toBe('partial');
    expect(stopped.briefs).toHaveLength(20);
    expect(stopped.progress).toMatchObject({ done: 20, total: 25 });
    const made = provider.breakdownCalls;
    for (let i = 0; i < 3; i++) await breakdown(a, docId);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(provider.breakdownCalls).toBe(made);
  });
});

describe('stops that readers are told about', () => {
  test('a stop before the first batch still answers with progress and the reason', async () => {
    const a = app({ breakdownMaxUnits: 'all' });
    const docId = await ingestMany(a, 25);
    provider.behavior = () => {
      throw budgetError();
    };
    await breakdown(a, docId);
    const r = await vi.waitFor(async () => {
      const x = await breakdown(a, docId);
      expect(x.progress?.stoppedReason).toBe('budget_exhausted');
      return x;
    });
    expect(r.status).toBe('pending');
    expect(r.progress).toEqual({
      done: 0,
      total: 25,
      stoppedReason: 'budget_exhausted',
    });
  });

  test("pictures that ended on a spent budget show up in the cached breakdown's progress", async () => {
    const { createBreakdownService } = await import('./breakdown.js');
    const service = createBreakdownService(env.runtime, {
      publicMode: false,
      breakdownMaxUnits: 'all',
      pregenerateExamples: 'off',
    });
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'off' });
    const docId = await ingestMany(a, 12);
    await service.get(docId, { wait: false });
    const done = await vi.waitFor(async () => {
      const x = await service.get(docId, { wait: false });
      expect(x.status).toBe('cached');
      return x;
    });
    expect(done.progress).toBeUndefined();
    service.reportPicturesStopped?.(docId);
    expect((await service.get(docId, { wait: false })).progress).toMatchObject({
      stoppedReason: 'budget_exhausted',
    });
  });
});

describe("pregenerateExamples: 'all'", () => {
  const exampleFor = async (a: Hono, docId: string, id: string) =>
    (await example(a, docId, id)).status;

  test('draws every available example one at a time, in order, even for a bill past the small bound', async () => {
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'all' });
    const docId = await ingestMany(a, 14);
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const generate = provider.generateObject.bind(provider);
    provider.generateObject = async (req) => {
      const focus = /<focus>([^<]+)<\/focus>/.exec(
        JSON.stringify(req.prompt),
      )?.[1];
      if (!focus) return generate(req);
      order.push(focus);
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return await generate(req);
      } finally {
        active--;
      }
    };
    await breakdown(a, docId);
    await until(a, docId, 'cached');
    await vi.waitFor(
      () => {
        expect(order).toHaveLength(14);
      },
      { timeout: 8000 },
    );
    expect(peak).toBe(1);
    expect(order).toEqual(
      Array.from({ length: 14 }, (_, i) => `sec-${String(i + 1)}`),
    );
    await vi.waitFor(async () => {
      expect(await exampleFor(a, docId, 'sec-14')).toBe('ok');
    });
  });

  test("starts drawing a batch's examples before the breakdown has finished", async () => {
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'all' });
    const docId = await ingestMany(a, 25);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    provider.gate = async () => {
      if (++calls === 2) await held;
    };
    await breakdown(a, docId);
    await vi.waitFor(() => {
      expect(exampleCalls()).toBeGreaterThan(0);
    });
    expect((await breakdown(a, docId)).status).toBe('partial');
    release();
    await until(a, docId, 'cached');
    await vi.waitFor(
      () => {
        expect(exampleCalls()).toBe(25);
      },
      { timeout: 8000 },
    );
  });

  /** Scenario calls by part, counting the ones the test makes fail. */
  function failing(fails: (focus: string) => Error | undefined): string[] {
    const attempted: string[] = [];
    const generate = provider.scen.generateObject.bind(provider.scen);
    provider.scen.generateObject = (req) => {
      const focus = /<focus>([^<]+)<\/focus>/.exec(
        JSON.stringify(req.prompt),
      )?.[1];
      if (req.schemaName !== 'scenario' || !focus) return generate(req);
      attempted.push(focus);
      const error = fails(focus);
      return error ? Promise.reject(error) : generate(req);
    };
    return attempted;
  }

  test('a failed example is skipped and the pass goes on', async () => {
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'all' });
    const docId = await ingestMany(a, 6);
    const attempted = failing((focus) =>
      focus === 'sec-2' ? new AppError('RATE_LIMITED', 'limit') : undefined,
    );
    await breakdown(a, docId);
    await until(a, docId, 'cached');
    await vi.waitFor(
      () => {
        expect(attempted).toEqual(
          Array.from({ length: 6 }, (_, i) => `sec-${String(i + 1)}`),
        );
      },
      { timeout: 8000 },
    );
    await vi.waitFor(async () => {
      expect(await exampleFor(a, docId, 'sec-6')).toBe('ok');
    });
  });

  test(`the ${String(MAX_EXAMPLE_FAILURES)}rd failure ends the pass for the document`, async () => {
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'all' });
    const docId = await ingestMany(a, 8);
    const attempted = failing(() => new AppError('RATE_LIMITED', 'limit'));
    await breakdown(a, docId);
    await until(a, docId, 'cached');
    await vi.waitFor(() => {
      expect(attempted).toHaveLength(MAX_EXAMPLE_FAILURES);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(attempted).toHaveLength(MAX_EXAMPLE_FAILURES);
  });

  test('a spent budget ends the pass at once, keeps what is drawn, and is reported', async () => {
    const a = app({ breakdownMaxUnits: 'all', pregenerateExamples: 'all' });
    const docId = await ingestMany(a, 8);
    const attempted = failing((focus) =>
      focus === 'sec-3' ? budgetError() : undefined,
    );
    await breakdown(a, docId);
    await until(a, docId, 'cached');
    const reported = await vi.waitFor(async () => {
      const r = await breakdown(a, docId);
      expect(r.progress?.stoppedReason).toBe('budget_exhausted');
      return r;
    });
    expect(reported.status).toBe('cached');
    await new Promise((resolve) => setTimeout(resolve, 100));
    // sec-1 and sec-2 were drawn, sec-3 hit the budget, nothing after it was tried.
    expect(attempted).toEqual(['sec-1', 'sec-2', 'sec-3']);
    expect(await exampleFor(a, docId, 'sec-1')).toBe('ok');
  });

  test("'off' draws nothing, and 'small' keeps the 1-8 rule", async () => {
    const a = app({ pregenerateExamples: 'off' });
    const docId = await ingestMany(a, 3);
    await breakdown(a, docId);
    await until(a, docId, 'cached');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(exampleCalls()).toBe(0);
    const b = app({ pregenerateExamples: 'small' });
    await breakdown(b, docId);
    await vi.waitFor(
      () => {
        expect(exampleCalls()).toBe(3);
      },
      { timeout: 8000 },
    );
  });
});
