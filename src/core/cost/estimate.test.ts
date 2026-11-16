import { describe, expect, it } from 'vitest';
import { makeSectionedText } from '../../../tests/synth/text.js';
import type { Section } from '../model/index.js';
import {
  OHIO_SHAPE,
  S1582_SHAPE,
  shapedBill,
  type BillShape,
} from '../../../tests/synth/bill-shape.js';
import { billFacts } from './facts.js';
import {
  estimateBill,
  estimateQuestion,
  type EstimatePlan,
} from './estimate.js';

const plan: EstimatePlan = {
  answerModel: 'claude-sonnet-5-5',
  extractModel: 'claude-haiku-5-5',
};
const small = () => billFacts(makeSectionedText().groundTruth.sections);
function many(count: number, chars = 10_000): Section[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sec-${String(i + 1)}`,
    heading: 'Garden grants',
    level: 1,
    spans: [{ text: 'x'.repeat(chars), status: 'unchanged' }],
    children: [],
  }));
}

describe('estimateBill', () => {
  it('prices whole summary, rewrites, scenario, examples and extract features separately', () => {
    const result = estimateBill(small(), plan);
    expect(result.features.metadata).toMatchObject({
      model: plan.extractModel,
      low: { calls: 1 },
      high: { calls: 1, outputTokens: 600 },
    });
    expect(result.features.summary).toMatchObject({
      low: { calls: 1 },
      high: { calls: 2, outputTokens: 32_000 },
    });
    expect(result.features.summaryScenario).toMatchObject({
      low: { calls: 1, cachedInputTokens: 0, cacheWriteTokens: 0 },
      high: { calls: 2 },
    });
    expect(result.features.breakdown).toMatchObject({
      low: { calls: 1 },
      high: { calls: 3, outputTokens: 18_000 },
    });
    expect(result.features.examples).toMatchObject({
      low: { calls: 2 },
      high: { calls: 4 },
    });
    // Each picture batch: the call, one malformed retry and one redraw of dropped items.
    expect(result.features.pictures).toMatchObject({
      low: { calls: 2 },
      high: { calls: 6 },
    });
    expect(result.total.low.dollars).toBeGreaterThan(0);
    expect(result.total.high.dollars).toBeGreaterThan(result.total.low.dollars);
    for (const key of [
      'calls',
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'cacheWriteTokens',
      'dollars',
    ] as const) {
      expect(result.total.low[key]).toBeCloseTo(
        Object.values(result.features).reduce((n, f) => n + f.low[key], 0),
      );
      expect(result.total.high[key]).toBeCloseTo(
        Object.values(result.features).reduce((n, f) => n + f.high[key], 0),
      );
    }
  });
  it('models capped map/reduce, per-unit excerpt batches, and every retry/rewrite', () => {
    const facts = billFacts(many(80));
    const { features } = estimateBill(facts, plan);
    expect(features.summary).toMatchObject({
      low: { calls: 7 },
      high: { calls: 8 },
    });
    expect(features.breakdown).toMatchObject({
      low: { calls: 8 },
      high: { calls: 24 },
    });
    expect(features.summaryScenario.low.calls).toBe(0);
    expect(features.pictures).toMatchObject({
      low: { calls: 9 },
      high: { calls: 27 },
    });
    expect(features.examples).toMatchObject({
      low: { calls: 8 },
      high: { calls: 16 },
    });
    expect(features.summary.high.cachedInputTokens).toBe(0);
    const capped = estimateBill(billFacts(many(80), { breakdownUnitCap: 5 }), {
      ...plan,
      exampleCount: 2,
    });
    expect(capped.features.breakdown.low.calls).toBe(2);
    expect(capped.features.examples.low.calls).toBe(2);
  });
  it('derives the example count from the pre-generation policy; an explicit count wins', () => {
    const facts = billFacts(many(80), { breakdownUnitCap: 'all' });
    const examples = (p: Partial<typeof plan>) =>
      estimateBill(facts, { ...plan, ...p }).features.examples.low.calls;
    expect(examples({})).toBe(8);
    expect(examples({ pregenerateExamples: 'small' })).toBe(8);
    expect(examples({ pregenerateExamples: 'off' })).toBe(0);
    // Every unit, because which briefs offer an example is unknown until they exist.
    expect(examples({ pregenerateExamples: 'all' })).toBe(facts.breakdownUnits);
    expect(examples({ pregenerateExamples: 'all', exampleCount: 3 })).toBe(3);
  });
  it('uses a single excerpt summary without map/reduce for ten or fewer units', () => {
    const { features } = estimateBill(
      billFacts(many(2), { wholeBillMaxTokens: 0 }),
      plan,
    );
    expect(features.summary).toMatchObject({
      low: { calls: 1 },
      high: { calls: 2 },
    });
    expect(features.summaryScenario.low.calls).toBe(1);
  });
  it.each([false, true])(
    'increases with additional substantive sections within a strategy (excerpts: %s)',
    (excerpts) => {
      let previous = { low: 0, high: 0 };
      // Scenario eligibility is held fixed: omnibus classification intentionally disables it.
      for (const n of [1, 2, 5, 10, 11, 20, 30, 40, 60, 80]) {
        const result = estimateBill(
          billFacts(many(n, 1000), {
            wholeBillMaxTokens: excerpts ? 0 : 100_000,
          }),
          { ...plan, summaryScenario: false },
        );
        expect(result.total.low.dollars).toBeGreaterThanOrEqual(previous.low);
        expect(result.total.high.dollars).toBeGreaterThanOrEqual(previous.high);
        previous = {
          low: result.total.low.dollars,
          high: result.total.high.dollars,
        };
      }
    },
  );
  it('supports cold caches, no cache, disabled features, and thinking within output limits', () => {
    const facts = billFacts(many(30, 1000));
    const reuse = estimateBill(facts, plan);
    const cold = estimateBill(facts, { ...plan, cache: 'cold' });
    const uncached = estimateBill(facts, { ...plan, cache: 'none' });
    expect(reuse.features.breakdown.low.cachedInputTokens).toBeGreaterThan(0);
    expect(cold.features.breakdown.low.cachedInputTokens).toBe(0);
    // The high bound never counts on a cache hit, so a cold cache cannot raise it.
    expect(cold.total.high.dollars).toBe(reuse.total.high.dollars);
    expect(reuse.features.breakdown.high.cachedInputTokens).toBe(0);
    expect(uncached.features.breakdown.low.cacheWriteTokens).toBe(0);
    const thinking = estimateBill(facts, {
      ...plan,
      thinkingTokensPerCall: { low: 500, high: 1000 },
    });
    expect(thinking.total.low.outputTokens).toBeGreaterThan(
      reuse.total.low.outputTokens,
    );
    expect(thinking.total.high.outputTokens).toBe(
      reuse.total.high.outputTokens,
    );
    const disabled = estimateBill(facts, {
      ...plan,
      metadata: false,
      summary: false,
      breakdown: false,
      pictures: false,
      exampleCount: 0,
    });
    expect(disabled.total.high.calls).toBe(0);
    expect(estimateBill(billFacts([]), plan).total.high.calls).toBe(0);
  });
  it('errors on unknown models and invalid plan counts; accepts price overrides', () => {
    expect(() =>
      estimateBill(small(), { ...plan, answerModel: 'unknown' }),
    ).toThrow('No price configured');
    expect(() =>
      estimateBill(small(), {
        ...plan,
        extractModel: 'unknown',
        metadata: false,
      }),
    ).toThrow('No price configured');
    expect(() => estimateBill(small(), { ...plan, exampleCount: -1 })).toThrow(
      RangeError,
    );
    expect(() =>
      estimateBill(small(), {
        ...plan,
        thinkingTokensPerCall: { low: 2, high: 1 },
      }),
    ).toThrow(RangeError);
    expect(
      estimateBill(
        small(),
        { ...plan, answerModel: 'custom' },
        { custom: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
      ).total.high.dollars,
    ).toBeGreaterThan(0);
  });
});
it('quotes a separate question, with a cached whole prefix or roughly 4.5k excerpt input', () => {
  const whole = estimateQuestion(small());
  expect(whole).toMatchObject({ low: { calls: 1 }, high: { calls: 2 } });
  expect(whole.high.cachedInputTokens).toBe(0);
  expect(whole.high.cacheWriteTokens).toBeGreaterThan(0);
  const excerpts = estimateQuestion(billFacts(many(80)));
  // About 4.5K tokens of excerpts and framing, plus the prompt markup on the excerpts.
  expect(excerpts.low).toMatchObject({
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  });
  expect(excerpts.low.inputTokens).toBeGreaterThanOrEqual(4500);
  expect(excerpts.low.inputTokens).toBeLessThan(5500);
  expect(() =>
    estimateQuestion(small(), {}, { answerModel: 'unknown' }),
  ).toThrow('No price configured');
});

it('prices the high bound for the real prompt size, including the long-context tier', () => {
  // About 95K plain tokens: under Haiku's 100K tier by chars/4, over it once the <part> markup
  // the whole-bill prompt adds is counted.
  const facts = billFacts(many(95, 1000 * 4));
  expect(facts.mode).toBe('whole');
  const haiku = estimateBill(facts, {
    ...plan,
    answerModel: 'claude-haiku-5-5',
  });
  const summaryHigh = haiku.features.summary.high;
  expect(summaryHigh.inputTokens / summaryHigh.calls).toBeGreaterThan(
    facts.estimatedTokens * 1.25,
  );
  // Long-context rates are five times the base rates, so the high bound must reflect them.
  const base = estimateBill(billFacts(many(30, 1000 * 4)), {
    ...plan,
    answerModel: 'claude-haiku-5-5',
  }).features.summary.high;
  expect(summaryHigh.dollars / summaryHigh.inputTokens).toBeGreaterThan(
    (base.dollars / base.inputTokens) * 3,
  );
});

/**
 * The whole-bill input forecast against what the providers reported in the calibration run
 * (#385, docs/calibration.md): input tokens per call, cache reads and writes included, the same
 * for Haiku and Sonnet. The bills are synthetic trees with the real section counts, live
 * characters and (to within a few percent) prompt size, because unit tests use no fixtures or
 * network. Before #410 the high bound ran up to 1.87x low on these shapes.
 */
const NJ_SHAPE: BillShape = {
  divisions: 1,
  titles: 1,
  sectionsPerTitle: 1,
  sectionChars: 2003,
  headingChars: 30,
};
const CALIBRATED = [
  {
    name: 'S. 1582 (684 sections)',
    shape: S1582_SHAPE,
    promptCharacters: 195_113,
    measured: {
      summary: 76_133,
      breakdown: 73_513,
      scenario: 75_112,
      question: 76_098,
    },
  },
  {
    name: 'Ohio S.B. 113 (101 sections)',
    shape: OHIO_SHAPE,
    promptCharacters: 31_145,
    measured: {
      summary: 13_785,
      breakdown: 14_452,
      scenario: 14_286,
      question: 13_732,
    },
  },
  {
    name: 'NJ S. 1000 (3 sections)',
    shape: NJ_SHAPE,
    promptCharacters: 2486,
    measured: {
      summary: 2917,
      breakdown: 3504,
      scenario: 2258,
      question: 2864,
    },
  },
] as const;

describe.each(CALIBRATED)('whole-bill input forecast: $name', (bill) => {
  // The real bills were single-subject, so the scenario ran; a synthetic tree's heading words
  // decide that differently, and this suite is about sizing, not classification.
  const facts = {
    ...billFacts(shapedBill(bill.shape)),
    singleSubject: true,
  };
  const perCall = (t: { inputTokens: number; calls: number }): number =>
    t.inputTokens / t.calls;
  for (const answerModel of ['claude-haiku-5-5', 'claude-sonnet-5-5']) {
    const estimate = estimateBill(facts, { ...plan, answerModel });
    const question = estimateQuestion(facts, {}, { answerModel });
    it(`is shaped like the real prompt (${answerModel})`, () => {
      expect(facts.mode).toBe('whole');
      expect(
        facts.wholePromptCharacters / bill.promptCharacters,
      ).toBeGreaterThan(0.93);
      expect(facts.wholePromptCharacters / bill.promptCharacters).toBeLessThan(
        1.07,
      );
    });
    it(`bounds the measured input per call from above (${answerModel})`, () => {
      expect(perCall(estimate.features.summary.high)).toBeGreaterThanOrEqual(
        bill.measured.summary,
      );
      expect(perCall(estimate.features.breakdown.high)).toBeGreaterThanOrEqual(
        bill.measured.breakdown,
      );
      expect(
        perCall(estimate.features.summaryScenario.high),
      ).toBeGreaterThanOrEqual(bill.measured.scenario);
      expect(perCall(question.high)).toBeGreaterThanOrEqual(
        bill.measured.question,
      );
    });
    it(`keeps the low bound at or under the measured input per call (${answerModel})`, () => {
      expect(perCall(estimate.features.summary.low)).toBeLessThanOrEqual(
        bill.measured.summary,
      );
      expect(perCall(estimate.features.breakdown.low)).toBeLessThanOrEqual(
        bill.measured.breakdown,
      );
      expect(
        perCall(estimate.features.summaryScenario.low),
      ).toBeLessThanOrEqual(bill.measured.scenario);
      expect(perCall(question.low)).toBeLessThanOrEqual(bill.measured.question);
    });
  }
});

it('does not hold the high bound to the calibration shapes alone: markup-heavy bills cost more per character', () => {
  const dense = billFacts(shapedBill({ ...S1582_SHAPE, headingChars: 120 }));
  const sparse = billFacts(shapedBill({ ...S1582_SHAPE, headingChars: 20 }));
  const high = (f: typeof dense) =>
    estimateBill(f, plan).features.summary.high.inputTokens;
  expect(dense.characters).toBeGreaterThan(sparse.characters * 0.99);
  expect(high(dense)).toBeGreaterThan(high(sparse) * 1.3);
});
