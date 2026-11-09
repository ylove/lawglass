import { describe, expect, it, vi } from 'vitest';
import { makeSectionedText } from '../../../tests/synth/text.js';
import type { Section } from '../model/index.js';
import { envVar } from '../brand.js';
import { billFacts } from './facts.js';

function sections(count: number, chars = 100): Section[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `sec-${String(i + 1)}`,
    num: String(i + 1),
    heading: 'Garden grants',
    level: 1,
    spans: [{ text: 'x'.repeat(chars), status: 'unchanged' }],
    children: [],
  }));
}

describe('billFacts', () => {
  it('counts the parsed synthetic tree, includes children, and omits boilerplate briefs', () => {
    const facts = billFacts(makeSectionedText().groundTruth.sections);
    expect(facts).toMatchObject({
      sectionCount: 8,
      mode: 'whole',
      singleSubject: true,
      breakdownUnits: 2,
      mapUnits: 5,
    });
    expect(facts.estimatedTokens).toBe(Math.ceil(facts.characters / 4));
    expect(facts.mapUnitTokens).toHaveLength(5);
    expect(facts.breakdownUnitTokens).toHaveLength(2);
  });
  it('chooses excerpt mode from parse alone and respects both caps', () => {
    const facts = billFacts(sections(80, 10_000));
    expect(facts).toMatchObject({
      estimatedTokens: 200_000,
      mode: 'excerpts',
      mapUnits: 60,
      omittedMapUnits: 20,
      breakdownUnits: 30,
      omittedBreakdownUnits: 50,
      singleSubject: false,
    });
    expect(
      billFacts(sections(80), { breakdownUnitCap: 7 }).breakdownUnits,
    ).toBe(7);
    expect(
      billFacts(sections(80), { breakdownUnitCap: 50 }).breakdownUnits,
    ).toBe(50);
    expect(
      billFacts(sections(80), { breakdownUnitCap: Infinity }).breakdownUnits,
    ).toBe(80); // full coverage (#382): the summary's 60-part cut no longer applies
    expect(
      billFacts(sections(80), { breakdownUnitCap: 'all' }).breakdownUnits,
    ).toBe(80);
    expect(billFacts(sections(2), { breakdownUnitCap: 0 }).breakdownUnits).toBe(
      0,
    );
  });
  it('ignores struck text and is pure even when the environment forces excerpts', () => {
    vi.stubEnv(envVar('WHOLE_BILL_MAX_TOKENS'), '0');
    try {
      const tree = sections(1, 12);
      tree[0]!.spans.push({
        text: 'struck'.repeat(100_000),
        status: 'deleted',
      });
      const snapshot = structuredClone(tree);
      expect(billFacts(tree)).toMatchObject({
        characters: 12,
        estimatedTokens: 3,
        mode: 'whole',
      });
      expect(tree).toEqual(snapshot);
      expect(billFacts(tree, { wholeBillMaxTokens: 0 }).mode).toBe('excerpts');
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('handles empty sections and rejects invalid budgets and caps', () => {
    expect(billFacts([])).toMatchObject({
      characters: 0,
      breakdownUnits: 0,
      mapUnits: 0,
      singleSubject: false,
    });
    for (const value of [-1, 1.5, NaN]) {
      expect(() => billFacts([], { breakdownUnitCap: value })).toThrow(
        RangeError,
      );
      expect(() => billFacts([], { wholeBillMaxTokens: value })).toThrow(
        RangeError,
      );
    }
  });
});
