import { describe, expect, test } from 'vitest';
import {
  CalibrationReport,
  FEATURES,
  type Run,
  type Tokens,
} from './calibration-schema.js';
import { parseReport, recommend, renderReport } from './calibration-report.js';

const tokens = (dollars: number, calls = 1): Tokens => ({
  calls,
  inputTokens: 100,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 50,
  dollars,
});

function run(
  bill: string,
  measured: number,
  high: number,
  status: Run['status'] = 'completed',
): Run {
  const row = (m: number, h: number) => ({
    model: 'claude-haiku-5-5',
    estimate: { low: tokens(h / 4), high: tokens(h) },
    measured: { ...tokens(m), estimatedCalls: 0, unpricedCalls: 0 },
    ratioHigh: h > 0 ? m / h : null,
    ratioHighInput: 1,
    ratioHighOutput: 1,
  });
  return {
    bill,
    url: 'https://example.gov/x',
    plan: 'haiku',
    answerModel: 'claude-haiku-5-5',
    extractModel: 'claude-haiku-5-5',
    breakdownMaxUnits: 30,
    pregenerateExamples: 'small',
    status,
    caps: { maxUsd: 7, maxUsdPerRun: 2 },
    facts: {
      pages: null,
      sections: 100,
      tokens: 5000,
      mode: 'whole',
      units: 30,
      unitsUncapped: 90,
    },
    features: Object.fromEntries(
      FEATURES.map((f) => [f, row(measured, high)]),
    ) as Run['features'],
    questions: {
      asked: 2,
      estimate: { low: tokens(0.01), high: tokens(0.02) },
      measured: tokens(0.02, 2),
      ratioHigh: 0.5,
    },
    other: tokens(0, 0),
    total: {
      estimate: { low: tokens(high), high: tokens(high * 6) },
      measured: tokens(measured * 6),
      ratioHigh: measured / high / 1,
      ratioLow: null,
    },
    quality: {
      summary: {
        items: 1,
        citations: 4,
        validCitations: 4,
        validityRate: 1,
        declines: 0,
        warned: 0,
      },
      briefs: {
        items: 30,
        citations: 30,
        validCitations: 29,
        validityRate: 29 / 30,
        declines: 1,
        warned: 0,
      },
      answers: {
        items: 2,
        citations: 6,
        validCitations: 6,
        validityRate: 1,
        declines: 0,
        warned: 0,
      },
    },
    coverage: {
      briefs: 30,
      omitted: 60,
      eligible: 28,
      pictures: 27,
      examples: null,
    },
    perUnit: {
      breakdownDollarsPerBrief: 0.01,
      picturesDollarsPerBrief: 0.005,
      examplesDollarsPerExample: null,
    },
    spentUsd: measured * 6,
    elapsedSeconds: 10,
  };
}

const report = (runs: Run[]): CalibrationReport =>
  CalibrationReport.parse({
    version: 1,
    generatedAt: '2026-11-09T00:00:00.000Z',
    dryRun: false,
    caps: { maxUsd: 10, maxUsdPerRun: 3 },
    spentUsd: 1.5,
    capReached: false,
    skipped: [{ bill: 'Later', plan: 'sonnet', reason: 'total cap reached' }],
    runs,
  });

describe('calibration report', () => {
  test('recommends 1.00 when every run is within its bound and a raise when one is over', () => {
    const fine = recommend(report([run('A', 0.5, 1), run('B', 0.2, 1)]));
    expect(fine.find((r) => r.feature === 'breakdown')).toMatchObject({
      worst: 0.5,
      multiplier: 1,
    });

    const over = recommend(report([run('A', 0.5, 1), run('B', 1.2, 1)]));
    // 1.2 x 1.25 = 1.5
    expect(over.find((r) => r.feature === 'pictures')?.multiplier).toBe(1.5);
  });

  test('renders the tables, the skipped runs and the extrapolation', () => {
    const md = renderReport(report([run('A', 0.5, 1)]));
    expect(md).toContain('# Cost estimator calibration');
    expect(md).toContain('| A | haiku | completed |');
    expect(md).toContain('0.50x');
    expect(md).toContain('Later on sonnet: total cap reached');
    expect(md).toContain('## Extrapolating a capped run');
    expect(md).toContain('## Recommendation for the high bound');
    expect(md).toContain('Every feature stayed within its high bound');
  });

  test('reads the JSON out of a job log', () => {
    const r = report([run('A', 0.5, 1)]);
    const log = `starting\nCALIBRATION REPORT ${JSON.stringify(r)}\ndone`;
    expect(parseReport(log)).toEqual(r);
    expect(parseReport(JSON.stringify(r))).toEqual(r);
  });
});

describe('a damaged final line', () => {
  test('falls back to the run lines when the report line is blank or invalid', () => {
    const a = run('A', 0.5, 1);
    for (const bad of [
      'CALIBRATION REPORT ',
      'CALIBRATION REPORT {"version":',
      '',
    ]) {
      const log = `CALIBRATION RUN ${JSON.stringify(a)}\n${bad}\n`;
      expect(parseReport(log).runs.map((r) => r.bill)).toEqual(['A']);
    }
    expect(() => parseReport('nothing here')).toThrow(/No calibration report/);
  });
});
