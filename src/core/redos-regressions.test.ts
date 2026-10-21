/**
 * Hostile-input regressions for the regexes rewritten under the `regexp/no-super-linear-*`
 * lint (#184). Each case pairs the behavior the rewrite must keep with a large adversarial
 * input that took seconds to minutes with the old pattern; the 2 s ceiling is far above the
 * linear cost and far below the quadratic one, so it only trips on a real regression.
 */
import { describe, expect, it } from 'vitest';
import { fleschKincaidGrade } from './answer/readability.js';
import { validateCitations } from './answer/citations.js';
import { classifyChunk } from './chunk/classify.js';
import { parseSponsor } from './enrich/metadata-guards.js';
import { segmentDefinitions } from './enrich/definitions.js';
import { findExternalMatches } from './enrich/refs.js';
import { normalizeSectionNum } from './enrich/section-index.js';
import { parseJson } from './llm/shared.js';

const N = 100_000;

function fast<T>(work: () => T): T {
  const started = performance.now();
  const result = work();
  expect(performance.now() - started).toBeLessThan(2_000);
  return result;
}

describe('citation markers', () => {
  it('still splits a multi-section marker', () => {
    const answer = validateCitations('See [S:a, b] and [S:c; S:d].', [
      'a',
      'b',
      'c',
      'd',
    ]);
    expect(answer.text).toBe('See [S:a] [S:b] and [S:c] [S:d].');
  });

  it('leaves an unclosed marker alone, quickly', () => {
    fast(() => validateCitations(`[S:${'a'.repeat(N)}`, ['a']));
    // Separators inside an unclosed bracket: the old pattern was quadratic on a single marker.
    fast(() => validateCitations(`[S:${',a'.repeat(N / 2)}`, ['a']));
    // Whitespace that is not next to a separator, inside a bracket that does close.
    fast(() => validateCitations(`[S:a${' '.repeat(N)}b,c]`, ['a']));
  });
});

describe('sentence counting', () => {
  it('counts a run of terminal punctuation once', () => {
    expect(fleschKincaidGrade('Stop!! Go now?! Fine.')).not.toBeNull();
    fast(() => fleschKincaidGrade(`word ${'!'.repeat(N)}x`));
  });
});

describe('chunk classification', () => {
  it('still recognises definitions and appropriations', () => {
    expect(classifyChunk('The term "farm" means a place.')).toBe('definition');
    expect(classifyChunk('“Farm” means a place.')).toBe('definition');
    expect(classifyChunk('Paid from the general funds, $5 million.')).toBe(
      'appropriation',
    );
  });

  it('survives long runs of quotes, spaces and prose', () => {
    fast(() => classifyChunk(`${'“'.repeat(N)}x`));
    fast(() => classifyChunk(`the term ${' '.repeat(N)}x`));
    fast(() => classifyChunk(`from the ${'a '.repeat(N)}`));
  });
});

describe('definitions', () => {
  it('finds labeled sibling definitions', () => {
    const text =
      '(A) "Farm" means a farm.\n(B) "Barn" means a barn.\n(C) Other text.';
    expect(segmentDefinitions(text).map((s) => s.term)).toEqual([
      'Farm',
      'Barn',
    ]);
  });

  it('survives runs of blank lines and label-like text', () => {
    fast(() =>
      segmentDefinitions(`(A) "Farm" means a farm.${'\n'.repeat(N)}(`),
    );
    fast(() => segmentDefinitions(`(A) "Farm" means x ${'\n \n'.repeat(N)}`));
    fast(() => segmentDefinitions(`the term ${' '.repeat(N)}x means`));
  });
});

describe('external references', () => {
  it('reads comma and word separated lists', () => {
    const [match] = findExternalMatches(
      'under sections 5747.01, 5747.02 and 5747.03 of the Revised Code',
    );
    expect(match?.citation).toBe('R.C. 5747.01');
    expect(
      findExternalMatches('section 552 to 559 of title 5, United States Code')
        .length,
    ).toBeGreaterThan(0);
  });

  it('survives long separators and digit runs', () => {
    fast(() =>
      findExternalMatches(`sections 1.2${' '.repeat(N)}x of the Revised Code`),
    );
    fast(() => findExternalMatches(`sections ${'1'.repeat(N)} of title 5`));
    fast(() => findExternalMatches(`title 5${' '.repeat(N)}x`));
  });
});

describe('trimming and parsing helpers', () => {
  it('normalizes section numbers', () => {
    expect(normalizeSectionNum('Sec. 3..  ')).toBe('3');
    fast(() => normalizeSectionNum(`3${'. '.repeat(N)}x`));
  });

  it('parses a sponsor with nested parentheses and stray dots', () => {
    expect(parseSponsor('Rep. John Smith Jr. (D-OH)')?.surname).toBe('Smith');
    fast(() => parseSponsor(`${'('.repeat(N)} Smith`));
    fast(() => parseSponsor(`${'.'.repeat(N)}x Smith`));
  });

  it('extracts fenced JSON', () => {
    expect(parseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJson('```JSON {"a":1}```')).toEqual({ a: 1 });
    expect(parseJson('```{"a":1}```')).toEqual({ a: 1 });
    expect(() => parseJson(`\`\`\`${' '.repeat(N)}x`)).toThrow();
    fast(() => {
      try {
        parseJson(`\`\`\`${' '.repeat(N)}x\`\`\` `);
      } catch {
        /* the point is the time taken */
      }
    });
  });
});
