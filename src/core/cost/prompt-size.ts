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
 * Ingest's limits (maximum chunks, parse time) are deliberately not applied: sizing an
 * already-indexed document must not fail because a host lowered a limit afterwards.
 */
import {
  billBudget,
  contextMode,
  dropOverlap,
  exceedsScanGuard,
  hitTokens,
  type ContextMode,
} from '../answer/context.js';
import { buildPrompt } from '../answer/prompt.js';
import { chunkDocument } from '../chunk/index.js';
import { enrichDocument } from '../enrich/index.js';
import {
  EMPTY_METADATA,
  type NormalizedDoc,
  type SearchHit,
  type Section,
} from '../model/index.js';
import { withInlineChanges } from '../pipeline/inline-changes.js';
import { scenarioExcerptBlock } from '../scenario/generate.js';
import { referenceTokens } from '../answer/references.js';

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
}
export const NO_PROMPT: WholePromptSizes = {
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
}
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

/** The first, cached block of a whole-mode prompt: the bill, then any references. */
function billBlock(
  metadata: NormalizedDoc['metadata'],
  hits: readonly SearchHit[],
  references: NonNullable<WholePromptInput['document']>['references'],
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

export function sizeWholePrompts(input: WholePromptInput): WholePromptSizing {
  const references = input.document?.references;
  // Breakdown asks `documentContext` without reserving reference tokens, so its decision can
  // differ from the summary's when references crowd the budget. The looser budget is checked
  // first: when even that is not whole, nothing is.
  const looseBudget = billBudget(input.configuredBudget, 0);
  const budget = billBudget(
    input.configuredBudget,
    referenceTokens(references),
  );
  const none: WholePromptSizing = { mode: 'excerpts', sizes: NO_PROMPT };
  if (looseBudget <= 0 || exceedsScanGuard(input.sections, false, looseBudget))
    return none;

  const doc = sizingDocument(input);
  const chunks = enrichDocument(
    doc,
    chunkDocument(doc, { maxChunks: Infinity, timeoutMs: 600_000 }),
  ).chunks;
  const all = dropOverlap(chunks.map((chunk) => ({ chunk, score: 1 })));
  const live = all.filter((hit) => hit.chunk.amendmentStatus !== 'deleted');
  if (contextMode(hitTokens(live), looseBudget) !== 'whole') return none;
  const breakdown = billBlock(doc.metadata, live, undefined);

  if (
    budget <= 0 ||
    exceedsScanGuard(input.sections, false, budget) ||
    contextMode(hitTokens(live), budget) !== 'whole'
  )
    return { mode: 'excerpts', sizes: { ...NO_PROMPT, breakdown } };

  const summary = billBlock(doc.metadata, live, references);
  let question = summary;
  // A question about changes reads struck text too, and may rule whole mode out on that
  // alone; when it does not, each changed section is rebuilt with inline markers.
  if (
    hasAmendments(input.sections) &&
    !exceedsScanGuard(input.sections, true, budget) &&
    contextMode(hitTokens(all), budget) === 'whole'
  )
    question = Math.max(
      question,
      billBlock(
        doc.metadata,
        withInlineChanges(
          all,
          { sections: [...input.sections] },
          doc.docId,
          true,
        ),
        references,
      ),
    );
  return {
    mode: 'whole',
    sizes: {
      summary,
      breakdown,
      scenario: scenarioExcerptBlock(live).length,
      question,
    },
  };
}
