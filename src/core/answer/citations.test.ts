import { describe, expect, it } from 'vitest';
import { DECLINE_TEXT } from '../model/index.js';
import { isDecline, validateCitations } from './citations.js';
import { hit } from './fixtures.js';

const chunks = [
  hit({
    id: 'c1',
    sectionId: 'sec-1',
    text: 'a',
    pageStart: 2,
    pageEnd: 2,
    lineStart: 5,
    lineEnd: 9,
  }).chunk,
  hit({
    id: 'c2',
    sectionId: 'sec-1',
    text: 'b',
    pageStart: 3,
    lineStart: 1,
    lineEnd: 4,
  }).chunk,
  hit({ id: 'c3', sectionId: 'sec-2', text: 'c' }).chunk,
];
const ids = ['sec-1', 'sec-2'];

/**
 * Catastrophic backtracking on these inputs takes seconds or more; a linear scan takes a few ms.
 * 250 ms tells them apart without flaking on a loaded or coverage-instrumented runner.
 */
const CATASTROPHIC_MS = 250;

describe('validateCitations', () => {
  it('accepts valid citations and builds locations from chunks', () => {
    const r = validateCitations(
      'It pays [S:sec-1]. It ends [S:sec-2].',
      ids,
      chunks,
    );
    expect(r.invalidCitations).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.text).toBe('It pays [S:sec-1]. It ends [S:sec-2].');
    expect(r.citations[0]).toEqual({
      sectionId: 'sec-1',
      valid: true,
      chunkIds: ['c1', 'c2'],
      breadcrumb: 'Sec. sec-1',
      location: { pageStart: 2, pageEnd: 3, lineStart: 5, lineEnd: 4 },
    });
    expect(r.citations[1]?.location).toBeUndefined();
  });

  it('strips invalid markers, records them once, and warns', () => {
    const r = validateCitations(
      'Yes [S:sec-1]. Also [S:fake] and [S:fake].',
      ids,
      chunks,
    );
    expect(r.text).toBe('Yes [S:sec-1]. Also and.');
    expect(r.invalidCitations).toEqual(['fake']);
    expect(r.warnings).toEqual(['INVALID_CITATIONS_REMOVED']);
    expect(r.citations.find((c) => c.sectionId === 'fake')).toEqual({
      sectionId: 'fake',
      valid: false,
      chunkIds: [],
    });
  });

  it('strips ids that contain regex characters', () => {
    const r = validateCitations('Hi [S:a.b(c)+] there.', ids);
    expect(r.text).toBe('Hi there.');
  });

  it('removes adjacent invalid markers and only their preceding spaces and tabs', () => {
    const r = validateCitations(
      '\t[S:fake][S:fake]A \t[S:fake]\n\t[S:fake] B\tC [S:sec-1]',
      ids,
    );
    expect(r.text).toBe('A\n B\tC [S:sec-1]');
    expect(r.invalidCitations).toEqual(['fake']);
  });

  it('warns when there are no valid citations', () => {
    const r = validateCitations('It pays money.', ids, chunks);
    expect(r.warnings).toEqual(['NO_VALID_CITATIONS']);
  });

  it('warns NO_VALID and INVALID when all citations are bogus', () => {
    const r = validateCitations('It pays [S:zzz].', ids);
    expect(r.warnings).toEqual([
      'NO_VALID_CITATIONS',
      'INVALID_CITATIONS_REMOVED',
    ]);
    expect(r.text).toBe('It pays.');
  });

  it('does not warn on a decline', () => {
    const r = validateCitations(`  ${DECLINE_TEXT}\n`, ids);
    expect(r.declined).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('does not treat a decline with extra words as a decline', () => {
    expect(isDecline(`${DECLINE_TEXT} But maybe.`)).toBe(false);
  });

  it('works with no chunks supplied', () => {
    const r = validateCitations('x [S:sec-1]', ids);
    expect(r.citations[0]).toEqual({
      sectionId: 'sec-1',
      valid: true,
      chunkIds: [],
    });
  });

  it('handles a lone end value when only a start exists', () => {
    const only = [
      hit({
        id: 'z',
        sectionId: 'sec-9',
        text: 't',
        pageStart: 4,
        lineStart: 2,
      }).chunk,
    ];
    const r = validateCitations('x [S:sec-9]', ['sec-9'], only);
    expect(r.citations[0]?.location).toEqual({
      pageStart: 4,
      pageEnd: 4,
      lineStart: 2,
      lineEnd: 2,
    });
  });

  it('ignores malformed markers', () => {
    const r = validateCitations('x [S:] [S: a] [s:sec-1]', ids);
    expect(r.citations).toEqual([]);
    expect(r.text).toBe('x [S:] [S: a] [s:sec-1]');
  });

  it('validates complete markers after unclosed openers, including multi-id markers', () => {
    const r = validateCitations(
      '[S:broken[S:sec-1, sec-2]. [S:broken[S:fake].',
      ids,
      chunks,
    );
    expect(r.text).toBe('[S:broken[S:sec-1] [S:sec-2]. [S:broken.');
    expect(r.citations.map((c) => [c.sectionId, c.valid])).toEqual([
      ['sec-1', true],
      ['sec-2', true],
      ['fake', false],
    ]);
    expect(r.invalidCitations).toEqual(['fake']);
    expect(r.warnings).toEqual(['INVALID_CITATIONS_REMOVED']);
  });

  it('validates 200,000 characters of unclosed markers in linear time', () => {
    const text = '[S:a'.repeat(50_000);
    const start = performance.now();
    const r = validateCitations(text, ids, chunks);
    const elapsed = performance.now() - start;

    expect(r.text).toBe(text);
    expect(r.citations).toEqual([]);
    expect(r.invalidCitations).toEqual([]);
    expect(r.warnings).toEqual(['NO_VALID_CITATIONS']);
    expect(r.declined).toBe(false);
    expect(elapsed).toBeLessThan(CATASTROPHIC_MS);
  });

  it.each([
    ['commas', ','],
    ['semicolons', ';'],
    ['mixed separators', ',;'],
    ['long ids', 'a'],
  ])(
    'validates an unclosed body of 200,000 %s in linear time',
    (_label, unit) => {
      const text = `[S:${unit.repeat(200_000 / unit.length)}`;
      const start = performance.now();
      const r = validateCitations(text, []);
      const elapsed = performance.now() - start;

      expect(r.text).toBe(text);
      expect(r.citations).toEqual([]);
      expect(r.invalidCitations).toEqual([]);
      expect(r.warnings).toEqual(['NO_VALID_CITATIONS']);
      expect(r.declined).toBe(false);
      expect(elapsed).toBeLessThan(CATASTROPHIC_MS);
    },
  );

  it('handles a closed body with 200,000 spaces in linear time', () => {
    const text = `[S:${' '.repeat(200_000)}sec-1,sec-2]`;
    const start = performance.now();
    const r = validateCitations(text, ids);
    const elapsed = performance.now() - start;

    expect(r.text).toBe(text);
    expect(r.citations).toEqual([]);
    expect(elapsed).toBeLessThan(CATASTROPHIC_MS);
  });

  it('strips an invalid marker after 200,000 unrelated spaces in linear time', () => {
    const text = `A${' '.repeat(200_000)}B [S:fake].`;
    const start = performance.now();
    const r = validateCitations(text, []);
    const elapsed = performance.now() - start;

    expect(r.text).toBe('A B.');
    expect(r.invalidCitations).toEqual(['fake']);
    expect(elapsed).toBeLessThan(CATASTROPHIC_MS);
  });

  describe('merged chunks', () => {
    const merged = hit({
      id: 'm',
      sectionId: 'sec-2',
      text: '(a) x\n\n(b) y',
      coveredSectionIds: ['sec-2', 'sec-2/a', 'sec-2/b'],
    }).chunk;
    it('treats a merged child as valid, with that chunk', () => {
      const r = validateCitations(
        'Y [S:sec-2/b].',
        ['sec-2', 'sec-2/a', 'sec-2/b'],
        [merged],
      );
      expect(r.invalidCitations).toEqual([]);
      expect(r.citations[0]?.chunkIds).toEqual(['m']);
    });
    it('does not match a child that was not merged', () => {
      const r = validateCitations(
        'Y [S:sec-2/c].',
        ['sec-2', 'sec-2/a', 'sec-2/b'],
        [merged],
      );
      expect(r.invalidCitations).toEqual(['sec-2/c']);
    });
    it('does not let sec-20 match sec-2', () => {
      const other = hit({ id: 'o', sectionId: 'sec-20', text: 'z' }).chunk;
      const r = validateCitations('Y [S:sec-20].', ['sec-20'], [merged, other]);
      expect(r.citations[0]?.chunkIds).toEqual(['o']);
    });
  });

  it('maps a cited prompt chunk id back to its section', () => {
    const r = validateCitations('It pays [S:c3].', ids, chunks);
    expect(r.text).toBe('It pays [S:sec-2].');
    expect(r.citations[0]?.sectionId).toBe('sec-2');
    expect(r.invalidCitations).toEqual([]);
  });

  it('splits multi-id markers and validates each id', () => {
    const r = validateCitations(
      'A [S:sec-1, sec-2]. B [S:sec-1; S:nope].',
      ids,
      chunks,
    );
    expect(r.text).toBe('A [S:sec-1] [S:sec-2]. B [S:sec-1].');
    expect(r.invalidCitations).toEqual(['nope']);
  });

  it('trims whitespace beside separators, including repeated S: prefixes', () => {
    const r = validateCitations('[S:sec-1 \t,\nS:sec-2\u00a0; S:sec-1]', ids);
    expect(r.text).toBe('[S:sec-1] [S:sec-2] [S:sec-1]');
    expect(r.citations.map((c) => c.sectionId)).toEqual(ids);
  });

  it.each(['[S: sec-1,sec-2]', '[S:sec-1,sec-2 ]'])(
    'preserves malformed whitespace at the outer edges of %s',
    (text) => {
      const r = validateCitations(text, ids);
      expect(r.text).toBe(text);
      expect(r.citations).toEqual([]);
    },
  );

  it('does not split a marker that is itself an allowed section id', () => {
    const r = validateCitations('A [S:sec-1, sec-2].', ['sec-1, sec-2'], []);
    expect(r.text).toBe('A [S:sec-1, sec-2].');
    expect(r.invalidCitations).toEqual([]);
  });

  it("maps a cited ordinal to that excerpt's section unless it is an allowed id", () => {
    const r = validateCitations('A [S:3]. B [S:2].', ['2', 'sec-2'], chunks);
    expect(r.text).toBe('A [S:sec-2]. B [S:2].');
  });

  it('leaves a comma marker with a bad part alone', () => {
    const r = validateCitations('A [S:sec-1, ].', ids, chunks);
    expect(r.text).toBe('A [S:sec-1, ].');
  });
});

describe('isDecline', () => {
  it.each([
    'This document doesn\u2019t address that question.',
    '"This document doesn\'t address that question."',
    "This document doesn't address that question",
    "**This document doesn't address that question.**",
    "This  document doesn't\naddress that question.",
  ])('accepts %s', (t) => {
    expect(isDecline(t)).toBe(true);
  });
  it('rejects extra words before or after', () => {
    expect(isDecline(`Sorry. ${DECLINE_TEXT}`)).toBe(false);
  });
});
