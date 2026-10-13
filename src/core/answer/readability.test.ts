import { describe, expect, it } from 'vitest';
import {
  countSyllables,
  fleschKincaidGrade,
  stripCitations,
} from './readability.js';

describe('countSyllables', () => {
  it.each([
    ['cat', 1],
    ['make', 1],
    ['walked', 1],
    ['table', 2],
    ['wanted', 2],
    ['water', 2],
    ['education', 4],
    ['yes', 1],
    ['a', 1],
  ])('%s -> %i', (w, n) => {
    expect(countSyllables(w)).toBe(n);
  });
  it('returns 0 for non-words', () => {
    expect(countSyllables('123')).toBe(0);
  });
});

describe('fleschKincaidGrade', () => {
  it('scores simple text low', () => {
    const g = fleschKincaidGrade(
      'The cat sat on the mat. The dog ran to the log.',
    );
    expect(g).not.toBeNull();
    expect(g!).toBeLessThan(2);
  });
  it('scores dense legal text high', () => {
    const g = fleschKincaidGrade(
      'Notwithstanding any other provision of law, the administrator shall promulgate regulations establishing comprehensive eligibility determinations.',
    );
    expect(g!).toBeGreaterThan(14);
  });
  it('matches a known sentence within tolerance', () => {
    // 6 words, 1 sentence, 7 syllables: 0.39*6 + 11.8*(7/6) - 15.59 = 0.52
    expect(fleschKincaidGrade('The quick brown fox jumps over.')).toBeCloseTo(
      0.5,
      0,
    );
  });
  it('ignores citation markers', () => {
    const a = fleschKincaidGrade('The state pays the fee.');
    const b = fleschKincaidGrade('The state pays the fee. [S:sec-4/b/2]');
    expect(b).toBe(a);
  });
  it('returns null with no words', () => {
    expect(fleschKincaidGrade('')).toBeNull();
    expect(fleschKincaidGrade('[S:a] ...')).toBeNull();
  });
  it('treats text without a terminator as one sentence', () => {
    expect(fleschKincaidGrade('no end here')).not.toBeNull();
  });
});

describe('stripCitations', () => {
  it('removes markers and collapses space', () => {
    expect(stripCitations('Hi [S:a] there [S:b/c]')).toBe('Hi there');
  });
});
