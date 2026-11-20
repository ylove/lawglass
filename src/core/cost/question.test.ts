import { describe, expect, it } from 'vitest';
import { makeSectionedText } from '../../../tests/synth/text.js';
import type { Section } from '../model/index.js';
import { estimateQuestion } from './estimate.js';
import { billFacts } from './facts.js';
import { questionCeiling } from './question.js';

const small = () => billFacts(makeSectionedText().groundTruth.sections);
function many(count: number, chars: number): Section[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sec-${String(i + 1)}`,
    heading: 'Garden grants',
    level: 1,
    spans: [{ text: 'x'.repeat(chars), status: 'unchanged' }],
    children: [],
  }));
}
/** About 75,000 tokens of live text: inside the whole-bill budget. */
const big = () => billFacts(many(30, 10_000));

describe('estimateQuestion by mode', () => {
  it('auto and whole read the whole bill when it fits; focused never does', () => {
    const facts = small();
    expect(facts.mode).toBe('whole');
    const auto = estimateQuestion(facts);
    expect(estimateQuestion(facts, {}, {}, { mode: 'auto' })).toEqual(auto);
    expect(estimateQuestion(facts, {}, {}, { mode: 'whole' })).toEqual(auto);
    const focused = estimateQuestion(facts, {}, {}, { mode: 'focused' });
    expect(focused.high.dollars).toBeLessThan(auto.high.dollars);
    expect(focused.high.outputTokens).toBe(2 * 8192);
  });

  it('a bill too long for whole reads excerpts whatever the mode', () => {
    const facts = billFacts(many(2, 10_000), { wholeBillMaxTokens: 0 });
    const auto = estimateQuestion(facts);
    expect(estimateQuestion(facts, {}, {}, { mode: 'whole' })).toEqual(auto);
  });

  it('defaults to the old caps and follows host caps', () => {
    const facts = small();
    expect(estimateQuestion(facts).high.outputTokens).toBe(16_000 * 2);
    const capped = estimateQuestion(
      facts,
      {},
      {},
      { limits: { wholeMaxTokens: 10_000 } },
    );
    expect(capped.high.outputTokens).toBe(10_000 * 2);
    const focused = estimateQuestion(
      facts,
      {},
      {},
      { mode: 'focused', limits: { focusedMaxTokens: 4096 } },
    );
    expect(focused.high.outputTokens).toBe(4096 * 2);
  });
});

describe('questionCeiling', () => {
  it('gives both modes for a bill that fits, the whole one costing more', () => {
    const ceiling = questionCeiling(small());
    expect(ceiling.model).toBe('claude-sonnet-5-5');
    expect(ceiling.whole).toBeDefined();
    expect(ceiling.whole!.dollars).toBeGreaterThan(ceiling.focused.dollars);
  });

  it('gives only the focused ceiling for a bill too long to read whole', () => {
    const ceiling = questionCeiling(
      billFacts(many(2, 10_000), { wholeBillMaxTokens: 0 }),
    );
    expect(ceiling.whole).toBeUndefined();
    expect(ceiling.focused.dollars).toBeGreaterThan(0);
  });

  it('is cheaper at a lower focused cap and ignores it for whole', () => {
    const facts = big();
    const base = questionCeiling(facts);
    const capped = questionCeiling(facts, {
      limits: { focusedMaxTokens: 4096 },
    });
    expect(capped.focused.dollars).toBeLessThan(base.focused.dollars);
    expect(capped.whole).toEqual(base.whole);
  });

  it('prices the model the host names, Haiku below Sonnet', () => {
    const facts = big();
    const haiku = questionCeiling(facts, {
      plan: { answerModel: 'claude-haiku-5-5' },
    });
    const sonnet = questionCeiling(facts, {
      plan: { answerModel: 'claude-sonnet-5-5' },
    });
    expect(haiku.model).toBe('claude-haiku-5-5');
    expect(haiku.whole!.dollars).toBeLessThan(sonnet.whole!.dollars);
  });

  it('honours a host price table for a model the built-in table lacks', () => {
    const rate = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const ceiling = questionCeiling(small(), {
      prices: { 'host-model': rate },
      plan: { answerModel: 'host-model' },
    });
    expect(ceiling.model).toBe('host-model');
    expect(ceiling.focused.dollars).toBeGreaterThan(0);
  });
});

describe('questionCeiling is a bound, not a forecast', () => {
  it('counts the optional story: up to two more calls on top of the answer', () => {
    const c = questionCeiling(small());
    // Whole: the answer and its rewrite, plus two story calls.
    const answerOnly = estimateQuestion(
      small(),
      {},
      {},
      { mode: 'whole', story: true },
    );
    expect(answerOnly.high.calls).toBe(4);
    expect(c.whole!.calls).toBe(4);
    expect(c.focused.calls).toBe(4);
    // The story's output is part of the bound, and the low forecast does not count it.
    expect(c.focused.outputTokens).toBe(2 * 8192 + 2 * 2000);
    expect(answerOnly.low.calls).toBe(1);
  });

  it('sizes focused input at the most an excerpt prompt can hold, not 3,500 tokens', () => {
    const c = questionCeiling(
      billFacts(many(2, 10_000), { wholeBillMaxTokens: 0 }),
    );
    // Two answer calls of about 18,000 tokens each plus framing, and the story's excerpts.
    expect(c.focused.inputTokens).toBeGreaterThan(2 * 18_000);
  });

  it('does not slow sizing for an amended bill that fits whole (no per-chunk re-rendering)', () => {
    const runs = (changed: boolean): Section[] => [
      {
        id: 'sec-1',
        heading: 'Grants',
        level: 1,
        spans: Array.from({ length: 400 }, (_, i) => ({
          text: `Clause ${String(i)} of the grant program applies to each town. `,
          status:
            changed && i % 2 === 0
              ? ('deleted' as const)
              : ('unchanged' as const),
        })),
        children: [],
      },
    ];
    const time = (sections: Section[]): number => {
      const start = performance.now();
      billFacts(sections);
      return performance.now() - start;
    };
    time(runs(true)); // warm up
    const plain = time(runs(false));
    const amended = time(runs(true));
    // It was about 12 times slower with the extra pass; generous so load cannot flake it.
    expect(amended).toBeLessThan(plain * 6 + 200);
  });
});
