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
import { MockProvider } from '../src/core/llm/mock.js';
import { resetSharedLimits } from '../src/core/pipeline/limits.js';
import {
  BILLS,
  PlanRun,
  QUESTIONS,
  defaultPlan,
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
