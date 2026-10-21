import { describe, expect, it } from 'vitest';
import { CITATION_PATTERN, findCitationIds, SectionId } from './index.js';

describe('CITATION_PATTERN', () => {
  it.each([
    'sec-4/b/2',
    'sec-5747.01/a',
    'a.b(c)+*?',
    'sec-1,sec-2;S:sec-3',
    '§4/é',
  ])('preserves full matches and the section-id capture for %s', (id) => {
    expect(SectionId.safeParse(id).success).toBe(true);
    expect(CITATION_PATTERN.flags).toBe('g');
    const marker = `[S:${id}]`;
    const matches = [...`A ${marker}${marker}.`.matchAll(CITATION_PATTERN)];
    expect(matches.map((m) => [m[0], m[1], m.index])).toEqual([
      [marker, id, 2],
      [marker, id, 2 + marker.length],
    ]);
    expect(findCitationIds(`A ${marker}${marker}.`)).toEqual([id, id]);
  });

  it.each([
    '',
    '[S:]',
    '[S:sec-1',
    '[s:sec-1]',
    '[S: sec-1]',
    '[S:sec 1]',
    '[S:sec\t1]',
    '[S:sec\n1]',
    '[S:sec\u00a01]',
    '[S:sec[1]',
  ])('ignores malformed markers in %j', (text) => {
    expect([...text.matchAll(CITATION_PATTERN)]).toEqual([]);
    expect(findCitationIds(text)).toEqual([]);
  });

  it('recovers a complete marker after unclosed openers without including brackets in its id', () => {
    const text = '[S:broken[S:also-broken[S:sec-2]] [S:sec-3]';
    expect(findCitationIds(text)).toEqual(['sec-2', 'sec-3']);
    expect([...text.matchAll(CITATION_PATTERN)].map((m) => m[0])).toEqual([
      '[S:sec-2]',
      '[S:sec-3]',
    ]);
  });

  it('scans 200,000 characters of unclosed markers in under 50 ms', () => {
    const text = '[S:a'.repeat(50_000);
    const start = performance.now();
    const ids = findCitationIds(text);
    const elapsed = performance.now() - start;

    expect(ids).toEqual([]);
    expect(elapsed).toBeLessThan(50);
  });
});
