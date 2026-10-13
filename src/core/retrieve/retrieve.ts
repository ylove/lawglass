/**
 * Retrieval orchestration (spec §5.6). Pure logic over the `RetrievalBackend` port: the backend
 * owns embedding, storage and reranking; this module decides which indexes to query, how to
 * merge them, which chunks to exclude and which definitions to append.
 *
 *   dense | sparse   one index, top `topK`
 *   hybrid           dense + sparse (40 candidates each) -> fusion -> top `topK`
 *   hybrid_rerank    hybrid candidates -> backend.rerank -> top `rerankTopN`   (default)
 *
 * Every mode then gets definition injection (see ./definitions.ts).
 */
import {
  addUsage,
  ZERO_USAGE,
  type BackendUsage,
  type ChunkFilter,
  type FusionMethod,
  type RetrievalBackend,
  type RetrievalMode,
  type SearchHit,
  type SearchIndex,
  type StoredChunk,
} from '../model/index.js';
import { findDefinitionsToInject } from './definitions.js';
import { reciprocalRankFusion, weightedFusion } from './fusion.js';

/** Candidates fetched from each index before fusion (spec §5.6). */
export const HYBRID_CANDIDATES = 40;
export const DEFAULT_TOP_K = 8;

/** Statuses that count as current law. `deleted` chunks hold only struck text. */
const LIVE_STATUSES: NonNullable<ChunkFilter['amendmentStatus']> = [
  'unchanged',
  'inserted',
];

export interface RetrieveOptions {
  docId: string;
  query: string;
  /** Default `hybrid_rerank`. */
  mode?: RetrievalMode | undefined;
  /** Chip metadata filter. Merged with the deleted-span exclusion. */
  filter?: ChunkFilter | undefined;
  /** Final number of hits for dense, sparse and hybrid. Default 8. */
  topK?: number | undefined;
  /** Hits kept after reranking. Defaults to `topK`. */
  rerankTopN?: number | undefined;
  /** Hybrid merge method. Default `rrf`; `weighted` is the eval variant. */
  fusion?: FusionMethod | undefined;
  /** Weight of the sparse list under `weighted` fusion, in [0, 1]. Default 0.5. */
  sparseWeight?: number | undefined;
  /** Keep deleted-span chunks (for "what changes / what is removed" questions and chips). */
  includeDeleted?: boolean | undefined;
  /** Time source in milliseconds; injectable so tests can pin latency. */
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

/** A hit plus whether it was appended by definition injection rather than ranked by search. */
export interface RetrievedHit extends SearchHit {
  injected: boolean;
}

export interface RetrievedContext {
  /** Ranked search hits first, then injected definitions. */
  hits: RetrievedHit[];
  /** The injected definition chunks alone (also present, marked `injected`, in `hits`). */
  injectedDefinitions: StoredChunk[];
  mode: RetrievalMode;
  /** Sum of every backend call made. */
  usage: BackendUsage;
  latencyMs: number;
}

/**
 * Combine the caller's chip filter with the deleted-span exclusion.
 * Returns `null` when the two contradict (e.g. the chip asks only for `deleted` chunks but
 * deleted ones are excluded), meaning nothing can match and no search is needed.
 */
export function buildFilter(
  chipFilter: ChunkFilter | undefined,
  includeDeleted: boolean,
): ChunkFilter | undefined | null {
  if (includeDeleted) return chipFilter;
  const requested = chipFilter?.amendmentStatus;
  const [first, ...rest] = requested
    ? requested.filter((s) => LIVE_STATUSES.includes(s))
    : LIVE_STATUSES;
  if (first === undefined) return null;
  return { ...chipFilter, amendmentStatus: [first, ...rest] };
}

export async function retrieve(
  backend: RetrievalBackend,
  options: RetrieveOptions,
): Promise<RetrievedContext> {
  const { docId, query, signal } = options;
  const mode = options.mode ?? 'hybrid_rerank';
  const topK = options.topK ?? DEFAULT_TOP_K;
  const now = options.now ?? Date.now;
  const startedAt = now();
  signal?.throwIfAborted();

  const filter = buildFilter(options.filter, options.includeDeleted ?? false);
  let usage: BackendUsage = ZERO_USAGE;
  let ranked: SearchHit[] = [];

  const search = async (
    index: SearchIndex,
    k: number,
  ): Promise<SearchHit[]> => {
    const result = await backend.search({
      docId,
      index,
      query,
      topK: k,
      // `null` (contradictory filter) never reaches here: the caller skips searching.
      filter: filter ?? undefined,
      signal,
    });
    usage = addUsage(usage, result.usage);
    return result.hits;
  };

  if (filter !== null) {
    if (mode === 'dense' || mode === 'sparse') {
      ranked = await search(mode, topK);
    } else {
      // Both indexes are independent, so query them concurrently.
      const [dense, sparse] = await Promise.all([
        search('dense', HYBRID_CANDIDATES),
        search('sparse', HYBRID_CANDIDATES),
      ]);
      const fused =
        options.fusion === 'weighted'
          ? weightedFusion(dense, sparse, options.sparseWeight)
          : reciprocalRankFusion([dense, sparse]);

      if (mode === 'hybrid' || fused.length === 0) {
        ranked = fused.slice(0, topK);
      } else {
        const reranked = await backend.rerank({
          query,
          hits: fused,
          topN: options.rerankTopN ?? topK,
          signal,
        });
        usage = addUsage(usage, reranked.usage);
        ranked = reranked.hits;
      }
    }
  }

  const injection = await findDefinitionsToInject({
    backend,
    docId,
    hits: ranked,
    amendmentStatus:
      filter === undefined || filter === null
        ? undefined
        : filter.amendmentStatus,
    signal,
  });
  usage = addUsage(usage, injection.usage);

  return {
    hits: [
      ...ranked.map((hit) => ({ ...hit, injected: false })),
      ...injection.definitions.map((hit) => ({ ...hit, injected: true })),
    ],
    injectedDefinitions: injection.definitions.map((hit) => hit.chunk),
    mode,
    usage,
    latencyMs: now() - startedAt,
  };
}
