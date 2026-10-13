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
      location: { pageStart: 2, pageEnd: 3, lineStart: 1, lineEnd: 9 },
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
});
