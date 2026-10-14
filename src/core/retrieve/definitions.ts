/**
 * Definition injection.
 *
 * Legislation defines terms once ("eligible town" means ...) and then uses them everywhere. A
 * retrieved operative chunk is hard to read, and easy for an LLM to misread, without the
 * definition of the terms it relies on. So after retrieval we look at which defined terms the
 * hits use and append the matching definition chunks that are not already in the result.
 */
import {
  addUsage,
  ZERO_USAGE,
  type BackendUsage,
  type ChunkFilter,
  type RetrievalBackend,
  type SearchHit,
} from '../model/index.js';

const LIVE: NonNullable<ChunkFilter['amendmentStatus']> = [
  'unchanged',
  'inserted',
];

/** Spec §5.6: at most this many definitions are appended to a result. */
export const MAX_INJECTED_DEFINITIONS = 5;

/**
 * Rank the defined terms used by `hits` that still need a definition, most-used first.
 * A term is "covered" when a non-deleted hit already is its definition chunk. Ties break alphabetically so
 * the result is deterministic.
 */
export function termsNeedingDefinitions(hits: readonly SearchHit[]): string[] {
  const covered = new Set<string>();
  const usage = new Map<string, number>();
  for (const { chunk } of hits) {
    // A struck definition does not cover a term: the live one must still be fetched.
    if (chunk.definesTerm !== undefined && chunk.amendmentStatus !== 'deleted')
      covered.add(chunk.definesTerm);
    // Count each term once per chunk even if the list repeats it.
    for (const term of new Set(chunk.definedTermsUsed)) {
      usage.set(term, (usage.get(term) ?? 0) + 1);
    }
  }
  return [...usage.entries()]
    .filter(([term]) => !covered.has(term))
    .sort(
      ([termA, countA], [termB, countB]) =>
        countB - countA || termA.localeCompare(termB),
    )
    .map(([term]) => term);
}

export interface InjectionRequest {
  backend: RetrievalBackend;
  docId: string;
  hits: readonly SearchHit[];
  /**
   * Status policy, independent of any chip's status focus: live definitions always; a struck
   * one only as a fallback when this is true.
   */
  includeDeleted: boolean;
  signal?: AbortSignal | undefined;
}

/**
 * Fetch up to `MAX_INJECTED_DEFINITIONS` definition chunks for terms used by `hits`.
 * Returns them in priority order (most-used term first) plus the backend usage spent.
 */
export async function findDefinitionsToInject(
  req: InjectionRequest,
): Promise<{ definitions: SearchHit[]; usage: BackendUsage }> {
  // Only the top terms can make the cap, so don't even ask for the rest.
  const terms = termsNeedingDefinitions(req.hits).slice(
    0,
    MAX_INJECTED_DEFINITIONS,
  );
  if (terms.length === 0) return { definitions: [], usage: ZERO_USAGE };

  // One filtered search per term (topK 1), concurrently, so a multi-chunk definition cannot
  // starve the others. The filter does the real work; the query only orders candidates.
  // Live (unchanged/inserted) definitions are preferred; a struck one is only a fallback when
  // deleted text is allowed and no live definition exists.
  const lookup = (
    term: string,
    statuses: NonNullable<ChunkFilter['amendmentStatus']>,
  ) =>
    req.backend.search({
      docId: req.docId,
      index: 'dense',
      query: term,
      topK: 1,
      filter: {
        definesTerm: [term],
        chunkType: ['definition'],
        amendmentStatus: statuses,
      },
      signal: req.signal,
    });
  const results = await Promise.all(
    terms.map(async (term) => {
      const liveResult = await lookup(term, LIVE);
      if (liveResult.hits.length > 0 || !req.includeDeleted) return liveResult;
      const struck = await lookup(term, ['deleted']);
      return {
        hits: struck.hits,
        usage: addUsage(liveResult.usage, struck.usage),
      };
    }),
  );
  let usage = ZERO_USAGE;
  const definitions: SearchHit[] = [];
  for (const result of results) {
    usage = addUsage(usage, result.usage);
    definitions.push(...result.hits.slice(0, 1));
  }
  return { definitions, usage };
}
