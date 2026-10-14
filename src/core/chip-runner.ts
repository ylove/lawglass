/**
 * Chip executor: turns a `ChipDefinition` (src/core/chips.ts) into an answer.
 *
 * It is a pure function over injected dependencies (`backend`, `provider`, document info), so
 * the pipeline (`pipeline/ask.ts`) can call it and tests can run it on in-memory doubles.
 *
 *   metadata      formatted from `BillMetadata`; no retrieval and no LLM call
 *   outline       chip-summary.ts: outline + first chunks, capped map-reduce
 *   what-changes  chip-changes.ts: struck and underlined runs read from the section tree
 *   definitions   every definition chunk, document-wide ones first, capped and counted
 *   retrieve      one `retrieve()` per query, merged, reranked once, then `answer()`
 */
import { answer, fleschKincaidGrade } from './answer/index.js';
import { runChangesChip } from './chip-changes.js';
import { runOutlineChip } from './chip-summary.js';
import {
  appendNote,
  type ChipDeps,
  type ChipRun,
  type RunChipOptions,
} from './chip-types.js';
import {
  addUsage,
  walkSections,
  ZERO_USAGE,
  type BackendUsage,
  type BillMetadata,
  type ChipDefinition,
  type SearchHit,
} from './model/index.js';
import { MAX_INJECTED_DEFINITIONS } from './retrieve/index.js';
import { findDefinitionsToInject } from './retrieve/definitions.js';
import {
  DEFAULT_TOP_K,
  RERANK_MAX_CANDIDATES,
  retrieve,
} from './retrieve/index.js';

/** `definitions` lists at most this many terms; the rest are counted, not shown. */
export const MAX_LISTED_DEFINITIONS = 25;

export async function runChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions = {},
): Promise<ChipRun> {
  switch (chip.strategy) {
    case 'metadata':
      return runMetadataChip(chip, deps.doc.metadata, options.onToken);
    case 'outline':
      return runOutlineChip(chip, docId, deps, options);
    case 'definitions':
      return runDefinitionsChip(chip, docId, deps, options);
    case 'retrieve':
      // The contract has no "spans" strategy, so what-changes is a `retrieve` chip by label
      // but is answered from the amendment spans (see chip-changes.ts for why).
      return chip.id === 'what-changes'
        ? runChangesChip(chip, docId, deps, options)
        : runRetrieveChip(chip, docId, deps, options);
  }
}

// ---------------------------------------------------------------------------------------------
// metadata: no retrieval, no LLM
// ---------------------------------------------------------------------------------------------

function runMetadataChip(
  chip: ChipDefinition,
  metadata: BillMetadata,
  onToken: ((text: string) => void) | undefined,
): ChipRun {
  const names = metadata.sponsors?.filter((s) => s.trim() !== '') ?? [];
  // Legacy names omit cosponsors. Official-record profiles keep the roles separate.
  let text =
    names.length === 0
      ? "This document doesn't say who sponsored it."
      : `Sponsored by ${names.join(', ')}. Cosponsors, if any, are not included.`;
  if (metadata.sponsorProfiles && metadata.sponsorProfiles.length > 0) {
    const sponsors = metadata.sponsorProfiles.filter(
      (p) => p.role === 'sponsor',
    );
    const cosponsors = metadata.sponsorProfiles.filter(
      (p) => p.role === 'cosponsor',
    );
    text =
      sponsors.length === 0
        ? "This document doesn't say who sponsored it."
        : `Sponsored by ${sponsors.map((p) => p.name).join(', ')}.`;
    if (cosponsors.length > 0) {
      const listed =
        cosponsors.length <= 10
          ? `: ${cosponsors.map((p) => p.name).join(', ')}`
          : '';
      text += ` Cosponsors (${String(cosponsors.length)})${listed}.`;
    }
  }
  onToken?.(text); // the CLI and UI print only streamed text
  return {
    answer: {
      text,
      citations: [],
      invalidCitations: [],
      warnings: [],
      declined: false,
      readingGrade: fleschKincaidGrade(text),
      provider: 'none',
      model: chip.id,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    hits: [],
    backendUsage: ZERO_USAGE,
    mode: 'none',
  };
}

// ---------------------------------------------------------------------------------------------
// retrieve
// ---------------------------------------------------------------------------------------------

async function runRetrieveChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const topK = chip.retrieval?.topK ?? DEFAULT_TOP_K;
  let backendUsage: BackendUsage = ZERO_USAGE;
  const perQuery: SearchHit[][] = [];

  // Queries run one after another: they are few (1-3) and sequential keeps backend load flat.
  // Definitions are injected once at the end, for the final list, not once per query.
  for (const query of chip.queries) {
    const context = await retrieve(deps.backend, {
      docId,
      query,
      mode: chip.retrieval?.mode,
      filter: chip.filter,
      topK,
      sparseWeight: chip.retrieval?.sparseWeight,
      includeDeleted: chip.retrieval?.includeDeleted,
      injectDefinitions: false,
      signal: options.signal,
    });
    backendUsage = addUsage(backendUsage, context.usage);
    perQuery.push(context.hits);
  }

  let ranked = interleave(perQuery);

  // Several keyword-style queries make good BM25 input but a weak ranking after interleaving,
  // so one cross-encoder pass orders the merged candidates against the chip's actual question.
  if (chip.queries.length > 1 && ranked.length > 1) {
    const reranked = await deps.backend.rerank({
      query: chip.label,
      hits: ranked.slice(0, RERANK_MAX_CANDIDATES),
      topN: topK,
      signal: options.signal,
    });
    backendUsage = addUsage(backendUsage, reranked.usage);
    ranked = reranked.hits;
  }
  ranked = ranked.slice(0, topK);

  const injection = await findDefinitionsToInject({
    backend: deps.backend,
    docId,
    hits: ranked,
    includeDeleted: chip.retrieval?.includeDeleted ?? false,
    signal: options.signal,
  });
  backendUsage = addUsage(backendUsage, injection.usage);
  const rankedIds = new Set(ranked.map((h) => h.chunk.id));
  const injected = injection.definitions
    .filter((h) => !rankedIds.has(h.chunk.id))
    .slice(0, MAX_INJECTED_DEFINITIONS);

  const result = await answer({
    provider: deps.provider,
    question: chip.label,
    context: {
      hits: ranked,
      definitions: injected,
      metadata: deps.doc.metadata,
    },
    chipInstruction: chip.answerInstruction,
    signal: options.signal,
    onToken: options.onToken,
    maxTokens: options.maxTokens,
  });
  return {
    answer: result,
    hits: [...ranked, ...injected],
    backendUsage,
    mode: chip.retrieval?.mode ?? 'hybrid_rerank',
  };
}

/**
 * Merge per-query result lists by rank: every query's best hit, then every query's second
 * best, and so on. Scores from different queries (or after reranking) are not comparable, but
 * ranks are. A chunk found by several queries is kept once, at its best rank.
 */
export function interleave(lists: readonly SearchHit[][]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const list of lists) {
      const hit = list[rank];
      if (hit && !seen.has(hit.chunk.id)) {
        seen.add(hit.chunk.id);
        out.push(hit);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// definitions
// ---------------------------------------------------------------------------------------------

/**
 * List the defined terms. Large bills define hundreds, so: fetch every definition chunk, put
 * definitions that apply to the whole document first (then limited ones), keep document order
 * within each group, show `MAX_LISTED_DEFINITIONS` and say how many more there are.
 */
async function runDefinitionsChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const context = await retrieve(deps.backend, {
    docId,
    query: chip.queries[0] ?? 'definitions',
    mode: chip.retrieval?.mode,
    filter: chip.filter,
    topK: chip.retrieval?.topK,
    injectDefinitions: false,
    signal: options.signal,
  });

  const order = new Map(
    [...walkSections(deps.doc.sections)].map((s, i) => [s.id, i] as const),
  );
  // scope by "term@section"; absent when the caller gave no definitions.
  const scopeRank = new Map(
    (deps.doc.definitions ?? []).map(
      (d) =>
        [
          `${d.term}@${d.sectionId}`,
          d.scope === 'document' ? 0 : d.scope === 'unknown' ? 1 : 2,
        ] as const,
    ),
  );
  const rank = (h: SearchHit): [number, number] => [
    scopeRank.get(`${h.chunk.definesTerm ?? ''}@${h.chunk.sectionId}`) ?? 1,
    order.get(h.chunk.sectionId) ?? Number.MAX_SAFE_INTEGER,
  ];
  const sorted = [...context.hits].sort((a, b) => {
    const [sa, oa] = rank(a);
    const [sb, ob] = rank(b);
    return sa - sb || oa - ob || a.chunk.id.localeCompare(b.chunk.id);
  });
  const shown = sorted.slice(0, MAX_LISTED_DEFINITIONS);
  const hidden = sorted.length - shown.length;

  const result = await answer({
    provider: deps.provider,
    question: chip.label,
    context: { hits: shown, metadata: deps.doc.metadata },
    chipInstruction: chip.answerInstruction,
    signal: options.signal,
    onToken: options.onToken,
    maxTokens: options.maxTokens,
  });
  const note =
    hidden > 0
      ? `${String(hidden)} more defined ${hidden === 1 ? 'term is' : 'terms are'} in the bill but not listed here.`
      : '';
  return {
    answer: appendNote(result, note, options.onToken),
    hits: shown,
    backendUsage: context.usage,
    mode: context.mode,
  };
}
