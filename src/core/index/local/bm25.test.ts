import { describe, expect, it } from 'vitest';
import { buildBm25, scoreBm25, tokenize } from './bm25.js';

describe('legislation tokenizer', () => {
  it('preserves sections, decimals, currency amounts and Unicode words', () => {
    expect(
      tokenize('The § 5747.01 levy is $5,000; and $2,000,000. Café—GRANTS!'),
    ).toEqual(['§', '5747.01', 'levy', '5000', '2000000', 'cafe', 'grants']);
    expect(tokenize('42 U.S.C. 1983 (A)(2)')).toEqual([
      '42',
      'u',
      's',
      'c',
      '1983',
      '2',
    ]);
    expect(tokenize('the AND of...')).toEqual([]);
  });

  it.each([
    ['1,2', ['1', '2']],
    ['$5,000', ['5000']],
    ['1,000,000', ['1000000']],
    ['3,4', ['3', '4']],
    ['1234,5678', ['1234', '5678']],
  ])('tokenizes %s without joining section lists', (text, expected) => {
    expect(tokenize(text)).toEqual(expected);
  });

  it('retrieves bare section numbers from comma-separated lists', () => {
    const index = buildBm25(['Sections 1,2 and 3,4']);
    expect(tokenize('Sections 1,2 and 3,4')).toEqual([
      'sections',
      '1',
      '2',
      '3',
      '4',
    ]);
    expect(scoreBm25(index, '3')[0]).toBeGreaterThan(0);
  });

  it('normalizes compatibility forms and accents while preserving section signs', () => {
    expect(tokenize('CAFÉ cafe cafe\u0301 ｃａｆé §５７４７.０１')).toEqual([
      'cafe',
      'cafe',
      'cafe',
      'cafe',
      '§',
      '5747.01',
    ]);
    const forms = ['café', 'cafe', 'cafe\u0301', 'ｃａｆé'];
    const index = buildBm25(forms);
    for (const query of forms) {
      const scores = scoreBm25(index, query);
      expect(scores[0]).toBeGreaterThan(0);
      expect(new Set(scores).size).toBe(1);
    }
  });
});

describe('explicit BM25', () => {
  it('counts document frequency once per chunk, term frequency per occurrence', () => {
    const index = buildBm25(['grant grant water', 'grant', 'water', '']);
    expect(index.lengths).toEqual([3, 1, 1, 0]);
    expect(index.averageLength).toBe(1.25);
    expect(index.documentFrequency).toEqual({ grant: 2, water: 2 });
    expect(index.termFrequency[0]).toEqual({ grant: 2, water: 1 });
  });

  it('implements k1=1.2, b=.75 and per-document IDF', () => {
    const index = buildBm25(['grant grant water', 'grant']);
    const [score] = scoreBm25(index, 'grant');
    expect(score).toBeCloseTo(
      (Math.log(1 + 0.5 / 2.5) * (2 * 2.2)) /
        (2 + 1.2 * (0.25 + (0.75 * 3) / 2)),
      12,
    );
    expect(scoreBm25(index, 'grant grant')).toEqual(scoreBm25(index, 'grant'));
  });

  it('handles empty corpora, empty documents, absent terms and prototype names', () => {
    expect(scoreBm25(buildBm25([]), 'grant')).toEqual([]);
    expect(scoreBm25(buildBm25(['', 'the of']), 'grant')).toEqual([0, 0]);
    expect(scoreBm25(buildBm25(['grants']), 'constructor')).toEqual([0]);
    expect(
      scoreBm25(buildBm25(['constructor']), 'constructor')[0],
    ).toBeGreaterThan(0);
    expect(scoreBm25(buildBm25(['grant']), 'the')).toEqual([0]);
  });

  it('favors rare exact sections and shorter chunks with the same overlap', () => {
    const scores = scoreBm25(
      buildBm25([
        'grants water',
        'grants water water water water',
        '§ 5747.01 grants',
      ]),
      'grants 5747.01',
    );
    expect(scores[2]).toBeGreaterThan(scores[0]!);
    expect(scores[0]).toBeGreaterThan(scores[1]!);
  });
});
