/**
 * Fusion: merge a dense result list and a sparse result list into one ranking.
 *
 * Dense and sparse scores live on different scales (cosine similarity vs. BM25), so raw scores
 * cannot simply be added. Two answers to that problem are implemented here, both pure functions:
 *
 * - `reciprocalRankFusion` (default): ignores scores entirely and only uses *ranks*.
 * - `weightedFusion` (eval variant): rescales each list's scores to [0, 1], then blends them.
 *
 * Both dedupe by chunk id: a chunk found by both indexes appears once, with a combined score.
 * Ties are broken by first appearance (dense list first), so output is fully deterministic.
 */
import type { SearchHit } from '../model/index.js';

/** The constant from the original RRF paper (Cormack et al., 2009). */
export const RRF_K = 60;

/**
 * Reciprocal Rank Fusion.
 *
 *   score(chunk) = sum over lists of  1 / (k + rank)      (rank is 1-based)
 *
 * Why it works: a chunk ranked highly in *either* list gets a big contribution, and one ranked
 * well in *both* gets two. `k` damps the gap between rank 1 and rank 2 so a single list can't
 * dominate. No score normalisation is needed, which makes it robust across backends.
 */
export function reciprocalRankFusion(
  lists: readonly (readonly SearchHit[])[],
  k: number = RRF_K,
): SearchHit[] {
  const merged = new Map<string, SearchHit>();
  for (const list of lists) {
    list.forEach((hit, index) => {
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = merged.get(hit.chunk.id);
      merged.set(hit.chunk.id, {
        chunk: existing?.chunk ?? hit.chunk,
        score: (existing?.score ?? 0) + contribution,
      });
    });
  }
  return sortByScore(merged);
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
