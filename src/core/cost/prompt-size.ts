/**
 * How many characters each whole-bill prompt really holds, measured by building it.
 *
 * Whole-bill mode sends every chunk as `<part id=".." section=".." heading="Division A > Title
 * II > Sec. 142 ..." status=".." page=".." lines="..">text</part>`. The tags, ids, breadcrumbs
 * and escaping are a large share of the prompt on a bill with many short sections, and a flat
 * factor on the bill's text cannot follow that: S. 1582 (684 sections) carries about 70,000
 * characters of markup on 125,000 of text.
 *
 * So this runs the code the runtime runs, feature by feature, and counts the result:
 *   - chunks: the ingest chunker, then `enrichDocument` (definitions split into chunks of
 *     their own), then `dropOverlap`, as `documentHits` does;
 *   - the whole-versus-excerpts decision: `billBudget`, `exceedsScanGuard` and `hitTokens`
 *     from `answer/context.ts`, the same helpers `documentContext` calls;
 *   - each feature's prompt: `buildPrompt` for the summary, breakdown and questions, and
 *     `scenarioExcerptBlock` for the scenario.
 * A change to a prompt format or to the selection rules moves the forecast with it.
 *
 * A quote passes the ingest's limits (maximum chunks, parse time) and so refuses what the ingest
 * would refuse, whatever mode it forecasts. Sizing an already-indexed document passes none, and
 * gets generous fixed caps instead, so a host that lowers a limit afterwards cannot make an
 * answerable document unsizable. One deadline and the caller's signal cover every stage.
 */
import {
  billBudget,
  contextMode,
  exceedsScanGuard,
  hitsInDocumentOrder,
  hitTokens,
  type ContextMode,
} from '../answer/context.js';
import { buildPrompt } from '../answer/prompt.js';
import { chunkDocument } from '../chunk/index.js';
import { enrichDocument } from '../enrich/index.js';
import {
  EMPTY_METADATA,
  type Definition,
  type ReferenceText,
  type NormalizedDoc,
  type SearchHit,
  walkSections,
  type Section,
} from '../model/index.js';
import { withInlineChanges } from '../pipeline/inline-changes.js';
import { scenarioExcerptBlock } from '../scenario/generate.js';
import { referenceTokens } from '../answer/references.js';
import { assertChunkLimit, ParseBudget } from '../parse/limits.js';
import { DEFAULT_TOP_K } from '../retrieve/retrieve.js';
import { MAX_INJECTED_DEFINITIONS } from '../retrieve/definitions.js';
import { MAX_EXCERPT_REFERENCES } from '../answer/references.js';
import { formatExcerpt } from '../answer/prompt.js';
import {
  findDefinitionTargets,
  MAX_TARGETS,
} from '../enrich/definition-refs.js';
import { MAX_TEXT_CHARS, referenceIdFor } from '../enrich/references.js';

/** Characters in each whole-bill prompt's bill-sized block; 0 where that prompt is not whole. */
export interface WholePromptSizes {
  /** Live parts and every reference text, in `<part>` format: the summary and model chips. */
  summary: number;
  /** Live parts in `<part>` format, no references: the breakdown batches. */
  breakdown: number;
  /** Live parts in `<excerpt>` format, no references: the summary scenario. */
  scenario: number;
  /**
   * The largest a question can send: the plain prompt, or, for a question about changes, every
   * part including struck text with each changed section rendered with its inline markers.
   */
  question: number;
  /**
   * The same blocks with a full-length placeholder for every U.S. Code reference the ingest
   * has yet to read (quote time only; otherwise equal to `summary` and `question`). They feed
   * the high bound alone: a failed read leaves the bill without them.
   */
  summaryHigh: number;
  questionHigh: number;
  /**
   * A question about changes that cannot read the whole bill (struck text takes it over budget)
   * is answered from retrieved excerpts: the largest such prompt, struck text and inline markers
   * included. Zero when that question is whole too, or nothing is amended.
   */
  changeExcerpts: number;
}
export const NO_PROMPT: WholePromptSizes = {
  summaryHigh: 0,
  questionHigh: 0,
  changeExcerpts: 0,
  summary: 0,
  breakdown: 0,
  scenario: 0,
  question: 0,
};

export interface WholePromptInput {
  sections: readonly Section[];
  /** The parsed document, for the metadata, definitions and references the runtime has. */
  document?: Pick<
    NormalizedDoc,
    'metadata' | 'definitions' | 'externalRefs' | 'references'
  >;
  /** The whole-bill token budget (`wholeBillMaxTokens`), before references are reserved. */
  configuredBudget: number;
  /**
   * True on the quote path, before ingest has read the U.S. Code references. The summary and
   * question blocks then carry a full-length placeholder for each target the document names.
   * An indexed document never gets placeholders: it has the references it has, or none.
   */
  preIngest?: boolean;
  /**
   * Chunk and time limits for the sizing work. A quote passes the ingest's own, so a bill the
   * ingest would refuse is refused at quote. Without them a fixed, generous cap applies:
   * sizing an already-indexed document must not fail because a host lowered a limit since.
   */
  limits?: { maxChunks?: number; timeoutMs?: number; signal?: AbortSignal };
}
/** Caps for sizing an indexed document: far above any bill the default limits admit. */
export const SIZING_MAX_CHUNKS = 50_000;
export const SIZING_TIMEOUT_MS = 120_000;
export interface WholePromptSizing {
  /** The mode summaries, scenarios and questions run in. */
  mode: ContextMode;
  sizes: WholePromptSizes;
}

/** The chunker validates this, and enrichment reads the document's metadata and definitions. */
function sizingDocument(input: WholePromptInput): NormalizedDoc {
  return {
    docId: '0'.repeat(64),
    sourceUrl: 'https://estimate.invalid/',
    format: 'text',
    fetchedAt: '2000-01-01T00:00:00.000Z',
    metadata: input.document?.metadata ?? EMPTY_METADATA,
    sections: [...input.sections],
    definitions: [...(input.document?.definitions ?? [])],
    externalRefs: [...(input.document?.externalRefs ?? [])],
    warnings: [],
  };
}

/**
 * Stand-ins for the U.S. Code texts a document's ingest will read, when it has not run yet (a
 * quote, an admission check). The targets come from the sections alone, with no network, and
 * each stand-in is as long as a read text can be. They size the prompt blocks only; the
 * whole-versus-excerpts decision never reserves for them (see `sizeWholePrompts`).
 */
export function placeholderReferences(
  sections: readonly Section[],
  definitions: readonly Definition[],
): ReferenceText[] {
  return findDefinitionTargets(sections, definitions)
    .slice(0, MAX_TARGETS)
    .map((target) => ({
      sectionId: referenceIdFor(target.title, target.section),
      citation: target.citation,
      heading: `§${target.section}. Definitions (2024 edition)`,
      sourceUrl: 'https://www.govinfo.gov/',
      text: 'x'.repeat(MAX_TEXT_CHARS),
      terms: target.terms.map((t) => t.term),
      fetchedAt: '2000-01-01T00:00:00.000Z',
    }));
}

/** The first, cached block of a whole-mode prompt: the bill, then any references. */
function billBlock(
  metadata: NormalizedDoc['metadata'],
  hits: readonly SearchHit[],
  references: readonly ReferenceText[] | undefined,
): number {
  const built = buildPrompt({
    mode: 'whole',
    question: '',
    hits,
    references,
    metadata,
  });
  const first = typeof built.user === 'string' ? undefined : built.user[0];
  return (first?.text ?? '').length;
}

function hasAmendments(sections: readonly Section[]): boolean {
  return sections.some(
    (s) =>
      s.spans.some((span) => span.status !== 'unchanged') ||
      hasAmendments(s.children),
  );
}

/** The excerpt-mode prompt for a change question: the largest retrieval could assemble. */
function changeExcerptBlock(
  metadata: NormalizedDoc['metadata'],
  all: readonly SearchHit[],
  sections: readonly Section[],
  docId: string,
  references: readonly ReferenceText[] | undefined,
  checkpoint: () => void,
): number {
  const doc = { sections: [...sections] };
  const size = (hit: SearchHit): number => formatExcerpt(hit).length;
  const definitions = all
    .filter((hit) => hit.chunk.chunkType === 'definition')
    .sort((a, b) => size(b) - size(a))
    .slice(0, MAX_INJECTED_DEFINITIONS);
  // The runtime keeps the top retrieved chunks first and only then renders each with its
  // changes inline (a chunk expands to every section it covers). So the largest prompt is the
  // DEFAULT_TOP_K chunks whose complete renderings are largest, not the largest renderings
  // out of a pool that was expanded first.
  const rendered = all
    .filter((hit) => !definitions.includes(hit))
    .map((hit) => {
      checkpoint();
      const hits = withInlineChanges([hit], doc, docId, false);
      return { hits, chars: hits.reduce((n, h) => n + size(h), 0) };
    })
    .sort((a, b) => b.chars - a.chars)
    .slice(0, DEFAULT_TOP_K);
  const bigRefs = [...(references ?? [])]
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, MAX_EXCERPT_REFERENCES);
  const built = buildPrompt({
    mode: 'excerpts',
    question: '',
    hits: rendered.flatMap((r) => r.hits),
    definitions,
    references: bigRefs,
    metadata,
  });
  return typeof built.user === 'string' ? built.user.length : 0;
}

export function sizeWholePrompts(input: WholePromptInput): WholePromptSizing {
  const timeoutMs = input.limits?.timeoutMs ?? SIZING_TIMEOUT_MS;
  // One deadline, and the caller's signal, over every stage and every long loop.
  const budget = new ParseBudget({ timeoutMs, signal: input.limits?.signal });
  const checkpoint = (): void => {
    budget.check();
  };
  const maxChunks = input.limits?.maxChunks ?? SIZING_MAX_CHUNKS;
  const doc = sizingDocument(input);
  const chunkOptions = { maxChunks, timeoutMs, signal: input.limits?.signal };

  // Breakdown asks `documentContext` without reserving reference tokens, so its decision can
  // differ from the summary's when references crowd the budget. The looser budget is checked
  // first: when even that is not whole, nothing is.
  const looseBudget = billBudget(input.configuredBudget, 0);
  const none: WholePromptSizing = { mode: 'excerpts', sizes: NO_PROMPT };
  const tooBig =
    looseBudget <= 0 || exceedsScanGuard(input.sections, false, looseBudget);
  // An indexed document passes no limits and, when too big for whole mode, needs no chunks.
  if (tooBig && input.limits === undefined) return none;

  // A quote checks what the ingest checks whatever mode it forecasts: the chunker's count, and
  // the count after enrichment splits definitions, since the ingest would refuse either.
  const chunked = chunkDocument(doc, chunkOptions);
  checkpoint();
  const enriched = enrichDocument(doc, chunked, checkpoint);
  assertChunkLimit(enriched.chunks.length, maxChunks);
  checkpoint();
  if (tooBig) return none;
  // The mode is chosen with the smallest reservation the runtime could make: the references
  // the document holds, or none. Whole mode costs more than excerpts, so near the threshold
  // that is the safe side, and it is what `documentContext` does for a document without them.
  const held = input.document?.references;
  const budgetAfterRefs = billBudget(
    input.configuredBudget,
    referenceTokens(held),
  );
  // Before ingest (a quote) the targets are known but not their text: the high bound sizes
  // the blocks that carry references with each at its longest. The enriched definitions can
  // name more targets than the parser's, so look them up there.
  const placeholders =
    held === undefined && input.preIngest === true
      ? placeholderReferences(input.sections, enriched.doc.definitions)
      : undefined;
  // The runtime's own ordering and overlap trimming (`documentHits`).
  const found = new Map<string, SearchHit>(
    enriched.chunks.map((chunk) => [chunk.id, { chunk, score: 1 }]),
  );
  const all = hitsInDocumentOrder(
    doc.docId,
    [...walkSections(input.sections)],
    found,
    checkpoint,
  );
  const live = all.filter((hit) => hit.chunk.amendmentStatus !== 'deleted');
  if (contextMode(hitTokens(live), looseBudget) !== 'whole') return none;
  const breakdown = billBlock(doc.metadata, live, undefined);
  checkpoint();

  if (
    budgetAfterRefs <= 0 ||
    exceedsScanGuard(input.sections, false, budgetAfterRefs) ||
    contextMode(hitTokens(live), budgetAfterRefs) !== 'whole'
  )
    return { mode: 'excerpts', sizes: { ...NO_PROMPT, breakdown } };

  const summary = billBlock(doc.metadata, live, held);
  const summaryHigh = billBlock(doc.metadata, live, placeholders ?? held);
  let question = summary;
  let questionHigh = summaryHigh;
  let changeExcerpts = 0;
  // A question about changes reads struck text too. When that keeps the bill whole, each
  // changed section is rebuilt with inline markers; when it does not, the runtime retrieves
  // excerpts (struck text included) instead.
  if (hasAmendments(input.sections)) {
    if (
      !exceedsScanGuard(input.sections, true, budgetAfterRefs) &&
      contextMode(hitTokens(all), budgetAfterRefs) === 'whole'
    ) {
      const inline = withInlineChanges(
        all,
        { sections: [...input.sections] },
        doc.docId,
        true,
        checkpoint,
      );
      question = Math.max(question, billBlock(doc.metadata, inline, held));
      questionHigh = Math.max(
        questionHigh,
        billBlock(doc.metadata, inline, placeholders ?? held),
      );
    } else {
      changeExcerpts = changeExcerptBlock(
        doc.metadata,
        all,
        input.sections,
        doc.docId,
        placeholders ?? held,
        checkpoint,
      );
    }
  }
  checkpoint();
  return {
    mode: 'whole',
    sizes: {
      summary,
      summaryHigh,
      breakdown,
      scenario: scenarioExcerptBlock(live).length,
      question,
      questionHigh,
      changeExcerpts,
    },
  };
}
