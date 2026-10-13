import { describe, expect, it } from 'vitest';
import type { SearchHit, StoredChunk } from '../model/index.js';
import { reciprocalRankFusion, RRF_K, weightedFusion } from './fusion.js';

const hit = (id: string, score: number): SearchHit => ({
  chunk: { id } as StoredChunk,
  score,
});
const ids = (hits: SearchHit[]): string[] => hits.map((h) => h.chunk.id);

describe('reciprocalRankFusion', () => {
  it('scores 1/(k+rank) per list and sums across lists', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 9), hit('b', 8)],
      [hit('b', 3), hit('c', 2)],
    ]);
    const score = (id: string) => fused.find((h) => h.chunk.id === id)!.score;
    expect(score('a')).toBeCloseTo(1 / (RRF_K + 1));
    expect(score('b')).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1));
    expect(score('c')).toBeCloseTo(1 / (RRF_K + 2));
    expect(ids(fused)).toEqual(['b', 'a', 'c']);
  });

  it('ignores raw score magnitudes (only rank matters)', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 0.001), hit('b', 0.0009)],
      [hit('c', 500)],
    ]);
    expect(ids(fused)).toEqual(['a', 'c', 'b']);
  });

  it('keeps disjoint lists, interleaved by rank', () => {
    const fused = reciprocalRankFusion([
      [hit('a', 1), hit('b', 1)],
      [hit('c', 1), hit('d', 1)],
    ]);
    expect(ids(fused)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('breaks ties by first appearance', () => {
    const fused = reciprocalRankFusion([[hit('x', 1)], [hit('y', 1)]]);
    expect(ids(fused)).toEqual(['x', 'y']);
  });

  it('handles empty lists', () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
    expect(ids(reciprocalRankFusion([[hit('a', 1)], []]))).toEqual(['a']);
  });

  it('honours a custom k', () => {
    const [top] = reciprocalRankFusion([[hit('a', 1)]], 10);
    expect(top!.score).toBeCloseTo(1 / 11);
  });
});

describe('weightedFusion', () => {
  it('min-max normalises each list then blends with the sparse weight', () => {
    const dense = [hit('a', 0.9), hit('b', 0.5)]; // -> a 1, b 0
    const sparse = [hit('b', 20), hit('c', 10)]; // -> b 1, c 0
    const fused = weightedFusion(dense, sparse, 0.25);
    const score = (id: string) => fused.find((h) => h.chunk.id === id)!.score;
    expect(score('a')).toBeCloseTo(0.75);
    expect(score('b')).toBeCloseTo(0.25);
    expect(score('c')).toBeCloseTo(0);
    expect(ids(fused)).toEqual(['a', 'b', 'c']);
  });

  it('defaults to an even blend', () => {
    const fused = weightedFusion(
      [hit('a', 2), hit('b', 1)],
      [hit('a', 2), hit('b', 1)],
    );
    expect(fused[0]!.score).toBeCloseTo(1);
  });

  it('weight 0 is dense-only and weight 1 is sparse-only', () => {
    const dense = [hit('a', 2), hit('b', 1)];
    const sparse = [hit('b', 2), hit('a', 1)];
    expect(ids(weightedFusion(dense, sparse, 0))[0]).toBe('a');
    expect(ids(weightedFusion(dense, sparse, 1))[0]).toBe('b');
  });

  it('treats a flat list (no score spread) as all ones', () => {
    const fused = weightedFusion([hit('a', 5), hit('b', 5)], [], 0.5);
    expect(fused.map((h) => h.score)).toEqual([0.5, 0.5]);
    expect(ids(fused)).toEqual(['a', 'b']);
  });

  it('keeps disjoint lists and handles empty ones', () => {
    expect(
      ids(weightedFusion([hit('a', 2), hit('b', 1)], [hit('c', 9)], 0.5)),
    ).toEqual(['a', 'c', 'b']); // a and c tie at 0.5; a was seen first;
    expect(weightedFusion([], [])).toEqual([]);
  });

  it('ignores duplicate ids within one list', () => {
    const fused = weightedFusion(
      [hit('a', 2), hit('a', 1), hit('b', 1)],
      [],
      0,
    );
    expect(fused.find((h) => h.chunk.id === 'a')!.score).toBeCloseTo(1);
  });

  it('rejects an out-of-range weight', () => {
    expect(() => weightedFusion([], [], 1.5)).toThrow(RangeError);
    expect(() => weightedFusion([], [], Number.NaN)).toThrow(RangeError);
  });
});
