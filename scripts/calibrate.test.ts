import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { breakdownProvider } from '../tests/support/breakdown-provider.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../tests/support/pipeline-env.js';
import { scenarioProvider } from '../tests/support/scenario-provider.js';
import { makeSectionedText } from '../tests/synth/index.js';
import { envVar } from '../src/core/brand.js';
import { resolveNewJersey } from '../src/core/fetch/new-jersey.js';
import { resolveNewYork } from '../src/core/fetch/new-york.js';
import { resolveHistory } from '../src/core/history/resolve.js';
import type { CliRuntime } from '../src/cli/runtime.js';
import { z } from 'zod';
import { PRICES, callDollars } from '../src/core/cost/index.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { resetSharedLimits } from '../src/core/pipeline/limits.js';
import {
  BILLS,
  PlanRun,
  QUESTIONS,
  defaultPlan,
  dryRuntime,
  worstCallDollars,
  runCalibration,
  type CalibrationOptions,
} from './calibrate.js';
import { CalibrationReport, FEATURES } from './calibration-schema.js';

const BILL = 'https://govinfo.gov/big.txt';
let env: PipelineEnv;

beforeEach(async () => {
  env = await makePipelineEnv();
  env.serve(BILL, makeSectionedText(), 'text/plain');
  // Every model call reports a few tokens, so there is something to price.
  Object.assign(env.runtime, {
    answerProvider: breakdownProvider(scenarioProvider(env.provider)),
    providerFor: (_role: string, model?: string) =>
      breakdownProvider(scenarioProvider(new MockProvider(model))),
  });
  vi.stubEnv(envVar('MAX_CALLS_PER_MINUTE'), '100000');
  resetSharedLimits();
});
afterEach(async () => {
  await new Promise((resolve) => setTimeout(resolve, 80));
  vi.unstubAllEnvs();
  resetSharedLimits();
  await env.cleanup();
});

const run = (name: string, plan = 'haiku'): PlanRun => ({
  bill: name,
  url: BILL,
  plan,
  answerModel: 'claude-haiku-5-5',
  extractModel: 'claude-haiku-5-5',
  breakdownMaxUnits: 'all',
  pregenerateExamples: 'all',
});
const options = (over: Partial<CalibrationOptions>): CalibrationOptions => ({
  runtime: env.runtime,
  plan: [run('Synthetic')],
  maxUsd: 10,
  maxUsdPerRun: 3,
  dryRun: true,
  pollMs: 5,
  idleMs: 60,
  runTimeoutMs: 30_000,
  ...over,
});

describe('calibration against the mock provider', () => {
  test('runs a bill end to end and writes a valid report', async () => {
    const report = await runCalibration(options({}));
    // The report round-trips through its own schema.
    expect(CalibrationReport.parse(JSON.parse(JSON.stringify(report)))).toEqual(
      report,
    );
    expect(report.capReached).toBe(false);
    expect(report.skipped).toEqual([]);
    const [r] = report.runs;
    expect(r?.status).toBe('completed');
    expect(r?.facts?.units).toBeGreaterThan(0);
    for (const f of FEATURES) expect(r?.features[f]).toBeDefined();
    // The breakdown made real (mock) calls, was priced, and compared with its forecast.
    expect(r?.features.breakdown.measured.calls).toBeGreaterThan(0);
    expect(r?.features.breakdown.measured.dollars).toBeGreaterThan(0);
    expect(r?.features.breakdown.estimate.high.dollars).toBeGreaterThan(0);
    expect(r?.features.breakdown.ratioHigh).toBeGreaterThan(0);
    expect(r?.total.ratioHigh).not.toBeNull();
    expect(r?.coverage.briefs).toBe(r?.facts?.units);
    expect(r?.coverage.examples).not.toBeNull();
    expect(r?.questions.asked).toBe(QUESTIONS.length);
    expect(r?.quality.briefs.validityRate).toBe(1);
    expect(r?.quality.answers.items).toBe(QUESTIONS.length);
    expect(r?.quote?.haiku?.high).toBeGreaterThan(0);
    expect(report.spentUsd).toBeCloseTo(r?.spentUsd ?? -1, 12);
    // No credential-shaped text can be in a report.
    expect(JSON.stringify(report)).not.toMatch(/sk-ant|api[-_]?key/i);
  }, 60_000);

  test('the total cap stops work and the later runs are reported as skipped', async () => {
    // One mock breakdown call costs about 7e-6 dollars, so this cap is spent by the first call.
    const cap = 2e-6;
    const report = await runCalibration(
      options({
        plan: [run('First'), run('Second', 'sonnet'), run('Third')],
        maxUsd: cap,
        minRunUsd: 0,
      }),
    );
    expect(report.capReached).toBe(true);
    expect(report.runs.map((r) => r.bill)).toEqual(['First']);
    expect(report.skipped.map((s) => s.bill)).toEqual(['Second', 'Third']);
    expect(report.skipped[0]?.reason).toMatch(/total cap/);
    expect(report.runs[0]?.status).not.toBe('completed');
    // Over by at most the calls already in flight, never by the rest of the bill.
    expect(report.spentUsd).toBeLessThan(cap + 1e-4);
    expect(CalibrationReport.safeParse(report).success).toBe(true);
  }, 60_000);

  test('the per-run cap stops one run but the next still starts', async () => {
    const report = await runCalibration(
      options({
        plan: [run('First'), run('Second')],
        maxUsdPerRun: 2e-6,
        minRunUsd: 0,
      }),
    );
    expect(report.runs).toHaveLength(2);
    expect(report.capReached).toBe(false);
    expect(report.runs.every((r) => r.status === 'stopped')).toBe(true);
    expect(report.runs[0]?.note).toMatch(/per-run cap|budget/);
  }, 60_000);

  test('a bill that cannot be fetched is a failed run, not an exception', async () => {
    const report = await runCalibration(
      options({
        plan: [{ ...run('Missing'), url: 'https://govinfo.gov/missing.txt' }],
      }),
    );
    expect(report.runs[0]?.status).toBe('failed');
    expect(report.runs[0]?.note).toBeTruthy();
    expect(CalibrationReport.safeParse(report).success).toBe(true);
  });
});

describe('the default plan', () => {
  const plan = defaultPlan();

  test('is valid and covers five small bills on two plans plus the capped NDAA', () => {
    for (const p of plan) expect(PlanRun.safeParse(p).success).toBe(true);
    const small = plan.filter((p) => p.bill !== 'H.R. 5009 (NDAA)');
    expect(small.filter((p) => p.plan === 'haiku')).toHaveLength(5);
    expect(small.filter((p) => p.plan === 'sonnet+haiku')).toHaveLength(5);
    const ndaa = plan.filter((p) => p.bill === 'H.R. 5009 (NDAA)');
    expect(ndaa).toHaveLength(1);
    expect(ndaa[0]).toMatchObject({
      timeoutMinutes: 25,
      answerModel: 'claude-haiku-5-5',
      extractModel: 'claude-haiku-5-5',
      breakdownMaxUnits: 30,
      pregenerateExamples: 'small',
    });
    expect(
      plan
        .filter((p) => p.plan === 'sonnet+haiku')
        .every((p) => p.answerModel === 'claude-sonnet-5-5'),
    ).toBe(true);
  });

  test('every URL is a form its resolver accepts', () => {
    expect(resolveHistory(BILLS['S. 1582'])).toMatchObject({
      source: 'govinfo',
    });
    expect(resolveHistory(BILLS['S. 5687'])).toMatchObject({
      source: 'govinfo',
    });
    expect(resolveHistory(BILLS['H.R. 5009 (NDAA)'])).toMatchObject({
      source: 'govinfo',
    });
    expect(resolveHistory(BILLS['Ohio S.B. 113'])).toMatchObject({
      source: 'ohio',
    });
    expect(resolveNewYork(BILLS['NY A. 5000'])).toBeDefined();
    expect(resolveNewJersey(BILLS['NJ S. 1000'])).toBeDefined();
  });
});

describe('the job deadline', () => {
  test('skips runs once it has passed and reports each finished run as it goes', async () => {
    const seen: string[] = [];
    const report = await runCalibration(
      options({
        plan: [run('Late')],
        deadlineAt: Date.now() - 1,
        onRun: (r) => seen.push(r.bill),
      }),
    );
    expect(report.runs).toEqual([]);
    expect(report.skipped[0]?.reason).toMatch(/deadline/);
    expect(report.capReached).toBe(false);

    await runCalibration(options({ onRun: (r) => seen.push(r.bill) }));
    expect(seen).toEqual(['Synthetic']);
  }, 60_000);
});

/** A provider that takes a moment and reports as much usage as the request allowed. */
function slowSpender(model?: string, delayMs = 20) {
  const inner = breakdownProvider(scenarioProvider(new MockProvider(model)));
  return {
    ...inner,
    id: inner.id,
    model: inner.model,
    streamText: inner.streamText.bind(inner),
    generateObject: async <T>(
      req: Parameters<typeof inner.generateObject<T>>[0],
    ) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const r = await inner.generateObject(req);
      return {
        ...r,
        usage: {
          // Prose tokenizes at about 2.7 characters a token.
          inputTokens: Math.ceil(
            JSON.stringify([req.system, req.prompt]).length / 2.7,
          ),
          outputTokens: req.maxTokens,
        },
      };
    },
  };
}

describe('the cap is hard', () => {
  test('calls in flight together never take the total past it', async () => {
    Object.assign(env.runtime, {
      providerFor: (_role: string, model?: string) => slowSpender(model),
    });
    // A call reserves up to about $0.04 (16,000 output tokens at Haiku's long-context rate), so the cap fits only a few.
    const cap = 0.1;
    const report = await runCalibration(
      options({ maxUsd: cap, minRunUsd: 0, plan: [run('A'), run('B')] }),
    );
    expect(report.spentUsd).toBeLessThanOrEqual(cap);
    expect(report.spentUsd).toBeGreaterThan(0);
    expect(report.runs[0]?.features.breakdown.measured.calls).toBeGreaterThan(
      0,
    );
  }, 60_000);

  test('a timed-out run keeps its own late usage and leaks none into the next', async () => {
    Object.assign(env.runtime, {
      providerFor: (_role: string, model?: string) => slowSpender(model, 40),
    });
    const report = await runCalibration(
      options({
        plan: [run('A'), run('B', 'sonnet')],
        runTimeoutMs: 1,
      }),
    );
    expect(report.runs.map((r) => r.status)).toEqual(['timeout', 'timeout']);
    // The run's clock starts after the ingest, so the ingest completed.
    expect(report.runs.every((r) => r.docId !== undefined)).toBe(true);
    const sum = report.runs.reduce((n, r) => n + r.spentUsd, 0);
    expect(report.spentUsd).toBeCloseTo(sum, 12);
  }, 60_000);

  test('the worst case of a call counts every output token and an unpriced model is the dearest', () => {
    const req = { system: 's', messages: [], maxTokens: 1_000_000 };
    const haiku = worstCallDollars('claude-haiku-5-5', req);
    const unknown = worstCallDollars('some-new-model', req);
    expect(haiku).toBeGreaterThanOrEqual(0.5);
    // Opus, at $20 per million output tokens, is the dearest built-in model.
    expect(unknown).toBeGreaterThanOrEqual(20);
  });
});

describe('the reservation bounds a real call', () => {
  test('a whole-bill Haiku prompt near the long-context threshold costs less than its reservation', () => {
    const text =
      'The department shall publish a rule for each grantee. '.repeat(
        Math.ceil(279_000 / 54),
      );
    const req = {
      system: 's',
      messages: [{ role: 'user', content: text }],
      maxTokens: 16_000,
    };
    const reserved = worstCallDollars('claude-haiku-5-5', req);
    // 279K characters at 2.7 per token is about 103K tokens: past the 100K long-context line.
    const actual = callDollars(
      {
        inputTokens: Math.ceil(text.length / 2.7),
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 16_000,
      },
      PRICES['claude-haiku-5-5'],
    );
    expect(reserved).toBeGreaterThanOrEqual(actual);
    // And the schema a structured call sends is counted too.
    const withSchema = worstCallDollars('claude-haiku-5-5', {
      ...req,
      prompt: text,
      schema: z.object({ a: z.array(z.string()) }),
    });
    expect(withSchema).toBeGreaterThan(reserved * 0.99);
  });
});

describe('the dry run', () => {
  test('answers every provider with the mock and never touches the real ones', async () => {
    const real = Object.create(env.runtime, {
      answerProvider: {
        get: () => {
          throw new Error('real answer provider used');
        },
      },
      extractProvider: {
        get: () => {
          throw new Error('real extract provider used');
        },
      },
      providerFor: {
        value: () => {
          throw new Error('real provider used');
        },
      },
    }) as CliRuntime;
    const dry = await dryRuntime(real);
    expect(dry.answerProvider.id).toBe('mock');
    expect(dry.extractProvider.id).toBe('mock');
    const routed = dry.providerFor('answer', 'claude-sonnet-5-5');
    expect(routed.id).toBe('mock');
    expect(routed.model).toBe('claude-sonnet-5-5');
  });
});
