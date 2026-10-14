/**
 * Chip executor: turns a `ChipDefinition` (src/core/chips.ts) into an answer.
 *
 * It is a pure function over injected dependencies (`backend`, `provider`, document metadata),
 * so the pipeline (`pipeline/ask.ts`) can call it and tests can run it on in-memory doubles.
 *
 *   retrieve      one `retrieve()` per chip query, merged round-robin, then `answer()`
 *   definitions   same, but a definition chunk is already the answer, so none are injected
 *   outline       first chunk of each top-level section; capped map-reduce on long bills
 *   metadata      formatted from `BillMetadata`; no retrieval and no LLM call
 */
import { answer, fleschKincaidGrade } from './answer/index.js';
import {
  DEFAULT_TOP_K,
  retrieve,
  type RetrievedHit,
} from './retrieve/index.js';
import {
  addUsage,
  makeChunkId,
  walkSections,
  ZERO_USAGE,
  type AnswerResult,
  type BackendUsage,
  type BillMetadata,
  type ChipDefinition,
  type Citation,
  type LlmProvider,
  type RetrievalBackend,
  type SearchHit,
  type Section,
  type StoredChunk,
} from './model/index.js';

/** Most top-level sections sent to the model in one call. */
export const MAX_SECTIONS_PER_MAP_CALL = 12;
/** Most map calls per summary. Sections beyond `MAX_SECTIONS_PER_MAP_CALL * MAX_MAP_CALLS` are left out. */
export const MAX_MAP_CALLS = 5;
/** How many chunks (the section's own, then its descendants') are tried to find a section's first chunk. */
const FIRST_CHUNK_CANDIDATES = 6;

/** What `runChip` needs to know about the document besides its chunks. */
export interface ChipDoc {
  metadata: BillMetadata;
  /** The section tree; only the top level is read, for the `outline` strategy. */
  sections: readonly Section[];
}

export interface ChipDeps {
  backend: RetrievalBackend;
  provider: LlmProvider;
  doc: ChipDoc;
}

export interface RunChipOptions {
  signal?: AbortSignal | undefined;
  /** Streamed pieces of the final answer (map-step text is not streamed). */
  onToken?: ((text: string) => void) | undefined;
  maxTokens?: number | undefined;
}

export interface ChipRun {
  answer: AnswerResult;
  /** The excerpts the model was shown, best first. Empty for `sponsors`. */
  hits: SearchHit[];
  /** Embedding and rerank usage for retrieval (LLM usage is inside `answer.usage`). */
  backendUsage: BackendUsage;
}

export async function runChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions = {},
): Promise<ChipRun> {
  switch (chip.strategy) {
    case 'metadata':
      return runMetadataChip(chip, deps.doc.metadata);
    case 'outline':
      return runOutlineChip(chip, docId, deps, options);
    case 'retrieve':
      return runRetrieveChip(chip, docId, deps, options, true);
    case 'definitions':
      return runRetrieveChip(chip, docId, deps, options, false);
  }
}

// ---------------------------------------------------------------------------------------------
// metadata: no retrieval, no LLM
// ---------------------------------------------------------------------------------------------

function runMetadataChip(
  chip: ChipDefinition,
  metadata: BillMetadata,
): ChipRun {
  // Only `sponsors` uses this strategy today; the label doubles as the question.
  const names = metadata.sponsors?.filter((s) => s.trim() !== '') ?? [];
  const text =
    names.length === 0
      ? "This document doesn't say who sponsored it."
      : `${names.length === 1 ? 'Sponsor' : 'Sponsors'}: ${names.join(', ')}.`;
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
  };
}

// ---------------------------------------------------------------------------------------------
// retrieve / definitions
// ---------------------------------------------------------------------------------------------

async function runRetrieveChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
  injectDefinitions: boolean,
): Promise<ChipRun> {
  const topK = chip.retrieval?.topK ?? DEFAULT_TOP_K;
  let backendUsage: BackendUsage = ZERO_USAGE;
  const perQuery: RetrievedHit[][] = [];

  // Queries run one after another: they are few (1-3) and sequential keeps backend load flat.
  for (const query of chip.queries) {
    const context = await retrieve(deps.backend, {
      docId,
      query,
      mode: chip.retrieval?.mode,
      filter: chip.filter,
      topK,
      sparseWeight: chip.retrieval?.sparseWeight,
      includeDeleted: chip.retrieval?.includeDeleted,
      injectDefinitions,
      signal: options.signal,
    });
    backendUsage = addUsage(backendUsage, context.usage);
    perQuery.push(context.hits);
  }

  const merged = interleave(perQuery);
  // Injected definitions ride along beyond the cap; they explain terms used by the ranked hits.
  const ranked = merged.filter((h) => !h.injected).slice(0, topK);
  const injected = merged.filter((h) => h.injected);

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
  return { answer: result, hits: [...ranked, ...injected], backendUsage };
}

/**
 * Merge per-query result lists by rank: every query's best hit, then every query's second
 * best, and so on. Scores from different queries (or after reranking) are not comparable, but
 * ranks are. A chunk found by several queries is kept once, at its best rank.
 */
export function interleave(lists: readonly RetrievedHit[][]): RetrievedHit[] {
  const seen = new Set<string>();
  const out: RetrievedHit[] = [];
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
// outline (summary)
// ---------------------------------------------------------------------------------------------

const MAP_INSTRUCTION =
  'These excerpts are the opening text of consecutive sections of one bill. Summarize what they do in two to five short sentences, citing the sections. Do not guess at sections you cannot see.';

const REDUCE_INSTRUCTION =
  'Each excerpt below is a partial summary of one part of the bill. It already carries section markers like [S:sec-1]. Combine the partial summaries into one summary, keep the markers on the sentences they support, and use only markers that appear in the partial summaries.';

async function runOutlineChip(
  chip: ChipDefinition,
  docId: string,
  deps: ChipDeps,
  options: RunChipOptions,
): Promise<ChipRun> {
  const firstChunks = await firstChunkPerTopLevelSection(
    deps.backend,
    docId,
    deps.doc.sections,
  );
  const hits: SearchHit[] = firstChunks.map((chunk) => ({ chunk, score: 1 }));
  const common = {
    provider: deps.provider,
    signal: options.signal,
    maxTokens: options.maxTokens,
  };
  const context = (h: SearchHit[]) => ({
    hits: h,
    metadata: deps.doc.metadata,
  });

  // Short bill: one call over the outline's first chunks.
  if (hits.length <= MAX_SECTIONS_PER_MAP_CALL) {
    const result = await answer({
      ...common,
      question: chip.label,
      context: context(hits),
      chipInstruction: chip.answerInstruction,
      onToken: options.onToken,
    });
    return { answer: result, hits, backendUsage: ZERO_USAGE };
  }

  // Long bill, map step: summarize batches of sections. The cap bounds cost and latency.
  const covered = hits.slice(0, MAX_SECTIONS_PER_MAP_CALL * MAX_MAP_CALLS);
  const batches = chunkArray(covered, MAX_SECTIONS_PER_MAP_CALL);
  const partials = await Promise.all(
    batches.map((batch) =>
      answer({
        ...common,
        question: chip.label,
        context: context(batch),
        chipInstruction: MAP_INSTRUCTION,
      }),
    ),
  );

  // Reduce step: the model sees the partial summaries as excerpts. Each stands in for the real
  // sections its citations point to (`coveredSectionIds`), so citation validation still works.
  const usable = partials.filter(
    (p) => !p.declined && p.citations.some((c) => c.valid),
  );
  const partHits = usable.map((p, i) => partialSummaryHit(docId, i, p));
  const final = await answer({
    ...common,
    question: chip.label,
    context: context(partHits),
    chipInstruction:
      `${REDUCE_INSTRUCTION} ${chip.answerInstruction ?? ''}`.trim(),
    onToken: options.onToken,
  });

  // Point citations back at the real chunks (with page and line) found in the map step.
  const real = new Map<string, Citation>();
  for (const c of partials.flatMap((p) => p.citations)) {
    if (c.valid) real.set(c.sectionId, c);
  }
  const usage = [...partials, final].reduce(
    (sum, r) => ({
      inputTokens: sum.inputTokens + r.usage.inputTokens,
      outputTokens: sum.outputTokens + r.usage.outputTokens,
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  return {
    answer: {
      ...final,
      citations: final.citations.map((c) => real.get(c.sectionId) ?? c),
      usage,
    },
    hits: covered,
    backendUsage: ZERO_USAGE,
  };
}

/** A map-step summary dressed as a chunk whose "text" is the summary and whose sections are those it cited. */
function partialSummaryHit(
  docId: string,
  index: number,
  partial: AnswerResult,
): SearchHit {
  const ids = [
    ...new Set(
      partial.citations.filter((c) => c.valid).map((c) => c.sectionId),
    ),
  ];
  const [first = ''] = ids;
  const chunk: StoredChunk = {
    id: `${docId}:summary-part:${String(index)}`,
    docId,
    sectionId: first,
    breadcrumb: `Partial summary ${String(index + 1)}`,
    chunkType: 'other',
    amendmentStatus: 'unchanged',
    text: partial.text,
    definedTermsUsed: [],
    refs: [],
    coveredSectionIds: ids,
    tokenCount: partial.usage.outputTokens,
  };
  return { chunk, score: 1 };
}

/**
 * The first live chunk of each top-level section, in document order. A top-level section with
 * no text of its own (a heading over subsections) falls back to its first descendant that has a
 * chunk. Chunk ids are deterministic (`makeChunkId`), so this is one `getChunks` call.
 */
async function firstChunkPerTopLevelSection(
  backend: RetrievalBackend,
  docId: string,
  sections: readonly Section[],
): Promise<StoredChunk[]> {
  const candidates = sections.map((top) =>
    [...walkSections([top])]
      .slice(0, FIRST_CHUNK_CANDIDATES)
      .map((s) => makeChunkId(docId, s.id, 0)),
  );
  const found = await backend.getChunks(docId, candidates.flat());
  const byId = new Map(found.map((c) => [c.id, c]));
  return candidates.flatMap((ids) => {
    const chunk = ids
      .map((id) => byId.get(id))
      .find((c) => c !== undefined && c.amendmentStatus !== 'deleted');
    return chunk ? [chunk] : [];
  });
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
