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
import { weightedFusion, weightedReciprocalRankFusion } from './fusion.js';

/** Candidates fetched from each index before fusion (spec §5.6). */
export const HYBRID_CANDIDATES = 40;
export const DEFAULT_TOP_K = 8;
/**
 * Most fused candidates sent to `backend.rerank`. Hosted rerankers cap documents per request
 * (Pinecone's `bge-reranker-v2-m3` and `pinecone-rerank-v0` accept at most 100), and two
 * disjoint lists of `HYBRID_CANDIDATES` would otherwise be the only bound. Ranks past 64 are
 * almost never promoted by the reranker, so cutting them also saves cross-encoder latency.
 */
export const RERANK_MAX_CANDIDATES = 64;

/**
 * Patterns that mark a question as being about changes. Each is tested with `.some`, so one
 * hit is enough. Bare nouns and stems are avoided on purpose ("snow removal", "climate change",
 * "report changes in income", "the amendment to section 5", "workers strike" must not match):
 * a verb counts only in a question form ("does it strike", "what changes") or as a participle.
 */
const CHANGE_PATTERNS: readonly RegExp[] = [
  // Past participles: "was struck", "is repealed", "has changed".
  /\b(?:removed|struck|stricken|deleted|repealed|eliminated|replaced|substituted|revised|modified|amended|changed)\b/i,
  // A change verb after an auxiliary, up to two words later: "does the bill remove", "to amend".
  /\b(?:do|does|did|to)\s+(?:\w+\s+){0,2}(?:remove|strike|delete|repeal|eliminate|replace|substitute|revise|modify|amend|change)\b/i,
  // "what changes for renters", "which sections change".
  /\b(?:what|which)\s+(?:\w+\s+)?chang(?:e|es)\b/i,
  // Fixed phrases about the law as it was.
  /\bno longer\b/i,
  /\bused to (?:be|say|require|allow)\b/i,
  /\b(?:current|existing) law\b/i,
  /\binstead of\b/i,
  /\b(?:say|said|law) before\b/i,
  /\bdiffer/i,
];

/**
 * Whether a question is about changes or removals, i.e. whether deleted (struck) text is
 * relevant to it (spec §5.6).
 */
export function asksAboutChanges(question: string): boolean {
  return CHANGE_PATTERNS.some((pattern) => pattern.test(question));
}

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
  /**
   * Weight of the sparse list in [0, 1]. Default 0.5. Under `rrf` (default) it is weighted RRF
   * (`w_dense = 2(1 - w)`, `w_sparse = 2w`; 0.5 is plain RRF); under `weighted` it blends
   * min-max scores.
   */
  sparseWeight?: number | undefined;
  /**
   * Keep deleted-span chunks. Default: `asksAboutChanges(query)`. A chip filter that explicitly
   * lists `deleted` in `amendmentStatus` is also an opt-in.
   */
  includeDeleted?: boolean | undefined;
  /**
   * Append definitions of terms used by the hits (default true). Injection always runs a dense
   * search, so eval measuring raw modes (embed tokens, latency) should pass false.
   */
  injectDefinitions?: boolean | undefined;
  /** Time source in milliseconds; injectable so tests can pin latency. */
  now?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

/** A hit plus whether it was appended by definition injection rather than ranked by search. */
export interface RetrievedHit extends SearchHit {
  injected: boolean;
}

export interface RetrievedContext {
  /**
   * Ranked search hits first, then injected definitions. Eval must score recall on
   * `hits.filter((h) => !h.injected)` so injection does not inflate per-mode numbers.
   */
  hits: RetrievedHit[];
  /** The injected definition chunks alone (also present, marked `injected`, in `hits`). */
  injectedDefinitions: StoredChunk[];
  mode: RetrievalMode;
  /** Sum of every backend call made. */
  usage: BackendUsage;
  latencyMs: number;
}

/**
 * Combine the caller's chip filter with the deleted-span exclusion. Unless deleted text is
 * wanted (`includeDeleted`, or the chip itself lists `deleted`), restrict to live statuses.
 * A chip asking only for `deleted` is an explicit opt-in, so it is never narrowed.
 */
export function buildFilter(
  chipFilter: ChunkFilter | undefined,
  includeDeleted: boolean,
): ChunkFilter | undefined {
  if (includeDeleted || chipFilter?.amendmentStatus?.includes('deleted')) {
    return chipFilter;
  }
  const [first, ...rest] = chipFilter?.amendmentStatus ?? LIVE_STATUSES;
  return { ...chipFilter, amendmentStatus: [first ?? 'unchanged', ...rest] };
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

  const includeDeleted =
    (options.includeDeleted ?? asksAboutChanges(query)) ||
    options.filter?.amendmentStatus?.includes('deleted') === true;
  const filter = buildFilter(options.filter, includeDeleted);
  const allowedStatuses = filter?.amendmentStatus;
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
      filter,
      signal,
    });
    usage = addUsage(usage, result.usage);
    return result.hits;
  };

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
        : weightedReciprocalRankFusion(dense, sparse, options.sparseWeight);

    if (mode === 'hybrid' || fused.length === 0) {
      ranked = fused.slice(0, topK);
    } else {
      const reranked = await backend.rerank({
        query,
        hits: fused.slice(0, RERANK_MAX_CANDIDATES),
        topN: options.rerankTopN ?? topK,
        signal,
      });
      usage = addUsage(usage, reranked.usage);
      ranked = reranked.hits;
    }
  }

  const inAllowed = (hit: SearchHit): boolean =>
    allowedStatuses === undefined ||
    allowedStatuses.includes(hit.chunk.amendmentStatus);
  // Defense in depth: whatever the backend did with the filter, nothing outside it gets out.
  ranked = ranked.filter(inAllowed);

  let injected: SearchHit[] = [];
  if (options.injectDefinitions ?? true) {
    const injection = await findDefinitionsToInject({
      backend,
      docId,
      hits: ranked,
      includeDeleted,
      signal,
    });
    usage = addUsage(usage, injection.usage);
    // The same chunk (e.g. a struck definition) may already be ranked; show it once.
    const rankedIds = new Set(ranked.map((hit) => hit.chunk.id));
    injected = injection.definitions.filter(
      (hit) => !rankedIds.has(hit.chunk.id),
    );
  }

  return {
    hits: [
      ...ranked.map((hit) => ({ ...hit, injected: false })),
      ...injected.map((hit) => ({ ...hit, injected: true })),
    ],
    injectedDefinitions: injected.map((hit) => hit.chunk),
    mode,
    usage,
    latencyMs: now() - startedAt,
  };
}
