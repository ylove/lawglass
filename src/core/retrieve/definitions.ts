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

/** Spec §5.6: at most this many definitions are appended to a result. */
export const MAX_INJECTED_DEFINITIONS = 5;

/**
 * Rank the defined terms used by `hits` that still need a definition, most-used first.
 * A term is "covered" when a hit already is its definition chunk. Ties break alphabetically so
 * the result is deterministic.
 */
export function termsNeedingDefinitions(hits: readonly SearchHit[]): string[] {
  const covered = new Set<string>();
  const usage = new Map<string, number>();
  for (const { chunk } of hits) {
    if (chunk.definesTerm !== undefined) covered.add(chunk.definesTerm);
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
  /** Same amendment-status restriction as the main search, so deleted definitions stay out. */
  amendmentStatus: ChunkFilter['amendmentStatus'];
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

  const filter: ChunkFilter = {
    definesTerm: terms,
    chunkType: ['definition'],
    ...(req.amendmentStatus ? { amendmentStatus: req.amendmentStatus } : {}),
  };
  // The filter does the real work; the query only orders candidates, so reuse the terms.
  // Ask for a few spare rows in case a term has more than one definition chunk.
  const { hits: candidates, usage } = await req.backend.search({
    docId: req.docId,
    index: 'dense',
    query: terms.join(' '),
    topK: terms.length * 2,
    filter,
    signal: req.signal,
  });

  // Keep the best candidate per term, then emit in term-priority order.
  const byTerm = new Map<string, SearchHit>();
  for (const candidate of candidates) {
    const term = candidate.chunk.definesTerm;
    if (term !== undefined && !byTerm.has(term)) byTerm.set(term, candidate);
  }
  const definitions = terms.flatMap((term) => byTerm.get(term) ?? []);
  return { definitions, usage: addUsage(ZERO_USAGE, usage) };
}
