/**
 * Fusion: merge a dense result list and a sparse result list into one ranking.
 *
 * Dense and sparse scores live on different scales (cosine similarity vs. BM25), so raw scores
 * cannot simply be added. Two answers to that problem are implemented here, both pure functions:
 *
 * - weighted RRF, `weightedReciprocalRankFusion` (default): ignores scores entirely and only uses
 *   *ranks*; at the default sparse weight of 0.5 it equals plain `reciprocalRankFusion`.
 * - `weightedFusion` (eval variant): rescales each list's scores to [0, 1], then blends them.
 *
 * Both dedupe by chunk id: a chunk found by both indexes appears once, with a combined score.
 * Within a single list a repeated id counts once, at its first (best) rank; later repeats are
 * ignored, in both methods. Ties are broken by first appearance (dense list first), so output
 * is fully deterministic.
 */
import type { SearchHit } from '../model/index.js';

/** The constant from the original RRF paper (Cormack et al., 2009). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion, optionally weighted.
 *
 *   score(chunk) = sum over lists of  w_i / (k + rank_i)      (rank is 1-based, w_i defaults to 1)
 *
 * Why it works: a chunk ranked highly in *either* list gets a big contribution, and one ranked
 * well in *both* gets two. `k` damps the gap between rank 1 and rank 2 so a single list can't
 * dominate. No score normalisation is needed, which makes it robust across backends.
 *
 * A repeated id within one list counts once, at its first rank (same as `weightedFusion`).
 * `weights` pairs with `lists` by index; missing entries default to 1.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly SearchHit[])[],
  k: number = RRF_K,
  weights: readonly number[] = [],
): SearchHit[] {
  const merged = new Map<string, SearchHit>();
  lists.forEach((list, listIndex) => {
    const weight = weights[listIndex] ?? 1;
    const seen = new Set<string>();
    list.forEach((hit, index) => {
      if (seen.has(hit.chunk.id)) return;
      seen.add(hit.chunk.id);
      const contribution = weight / (k + index + 1);
      const existing = merged.get(hit.chunk.id);
      merged.set(hit.chunk.id, {
        chunk: existing?.chunk ?? hit.chunk,
        score: (existing?.score ?? 0) + contribution,
      });
    });
  });
  return sortByScore(merged);
}

/**
 * RRF with a sparse/dense knob: `w_dense = 2(1 - w)`, `w_sparse = 2w`, so `w = 0.5` is exactly
 * plain RRF, `w = 0` ignores the sparse list's contribution and `w = 1` ignores the dense one's.
 */
export function weightedReciprocalRankFusion(
  dense: readonly SearchHit[],
  sparse: readonly SearchHit[],
  sparseWeight = 0.5,
  k: number = RRF_K,
): SearchHit[] {
  if (!(sparseWeight >= 0 && sparseWeight <= 1)) {
    throw new RangeError(
      `sparseWeight must be in [0, 1], got ${String(sparseWeight)}`,
    );
  }
  return reciprocalRankFusion([dense, sparse], k, [
    2 * (1 - sparseWeight),
    2 * sparseWeight,
  ]);
}

/**
 * Weighted min-max fusion.
 *
 *   normalised = (score - min) / (max - min)             per list, so the best hit is 1, worst 0
 *   fused      = (1 - w) * dense + w * sparse            w = sparseWeight in [0, 1]
 *
 * A chunk missing from one list contributes 0 from that side. A list whose scores are all equal
 * (max == min) has no spread to normalise, so every hit in it counts as 1: being present at all
 * is the only signal it carries. An empty list contributes nothing.
 */
export function weightedFusion(
  dense: readonly SearchHit[],
  sparse: readonly SearchHit[],
  sparseWeight = 0.5,
): SearchHit[] {
  if (!(sparseWeight >= 0 && sparseWeight <= 1)) {
    throw new RangeError(
      `sparseWeight must be in [0, 1], got ${String(sparseWeight)}`,
    );
  }
  const merged = new Map<string, SearchHit>();
  const addList = (list: readonly SearchHit[], weight: number): void => {
    for (const [hit, normalised] of minMaxNormalise(list)) {
      const existing = merged.get(hit.chunk.id);
      merged.set(hit.chunk.id, {
        chunk: existing?.chunk ?? hit.chunk,
        score: (existing?.score ?? 0) + weight * normalised,
      });
    }
  };
  addList(dense, 1 - sparseWeight);
  addList(sparse, sparseWeight);
  return sortByScore(merged);
}

/** Pair each distinct hit with its score rescaled to [0, 1], in input order. */
function minMaxNormalise(list: readonly SearchHit[]): Map<SearchHit, number> {
  const out = new Map<SearchHit, number>();
  const seen = new Set<string>();
  if (list.length === 0) return out;
  const scores = list.map((h) => h.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const spread = max - min;
  for (const hit of list) {
    // Keep the first occurrence if a backend ever returns the same chunk twice.
    if (!seen.has(hit.chunk.id)) {
      seen.add(hit.chunk.id);
      out.set(hit, spread === 0 ? 1 : (hit.score - min) / spread);
    }
  }
  return out;
}

/** Highest score first. Array.sort is stable, so ties keep Map insertion (first-seen) order. */
function sortByScore(merged: Map<string, SearchHit>): SearchHit[] {
  return [...merged.values()].sort((a, b) => b.score - a.score);
}
