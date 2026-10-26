/**
 * The text a model may use to write about ONE part of a bill: its own passages, the definitions
 * of terms it uses, the sections it refers to (one hop, never further), and other laws' text
 * that was read for this bill. Shared by the section-by-section briefs (excerpt mode) and the
 * per-section examples, so both are grounded in exactly the same material.
 *
 * Two sources feed it. In whole-bill mode the caller already holds every chunk (`pool`), so
 * nothing is fetched. For a large bill the unit's chunks are read by their deterministic ids
 * and definitions come from the same filtered search the answers use (`findDefinitionsToInject`).
 */
import { documentHits } from '../answer/context.js';
import { syntheticHit } from '../chip-types.js';
import {
  findDefinitionsToInject,
  termsNeedingDefinitions,
  MAX_INJECTED_DEFINITIONS,
} from '../retrieve/definitions.js';
import {
  walkSections,
  type NormalizedDoc,
  type RetrievalBackend,
  type SearchHit,
  type Section,
} from '../model/index.js';

/** Tokens of the unit's own text sent to the model; the rest of a very long part is cut. */
export const UNIT_TOKEN_BUDGET = 2500;
/** At most this many cross-referenced sections are added, each cut to `RELATED_TOKEN_BUDGET`. */
export const MAX_RELATED_SECTIONS = 3;
export const RELATED_TOKEN_BUDGET = 700;
/** Other laws read for this bill: at most this many, each cut to this many characters. */
export const MAX_REFERENCE_TEXTS = 3;
export const REFERENCE_CHAR_BUDGET = 3000;

export interface UnitContext {
  /** The part's own live passages, in document order. */
  hits: SearchHit[];
  /** Definition passages for terms the part uses. */
  definitions: SearchHit[];
  /** Passages of sections the part refers to (one hop). */
  related: SearchHit[];
  /** Other laws' text, as excerpts that cite the bill section that relies on it. */
  references: SearchHit[];
  /** Embedding and rerank usage spent finding definitions. */
  usage: { embedTokens: number; rerankUnits: number };
}

export interface UnitContextInput {
  backend: RetrievalBackend;
  docId: string;
  doc: Pick<NormalizedDoc, 'sections' | 'references' | 'externalRefs'>;
  unit: Section;
  /**
   * Every live chunk of the bill (whole-bill mode). When present the unit is read from it and
   * nothing is fetched or searched.
   */
  pool?: readonly SearchHit[] | undefined;
  signal?: AbortSignal | undefined;
}

/** Keep leading passages until the token budget is spent; always keep at least one. */
function withinBudget(hits: readonly SearchHit[], budget: number): SearchHit[] {
  const kept: SearchHit[] = [];
  let used = 0;
  for (const hit of hits) {
    if (kept.length > 0 && used + hit.chunk.tokenCount > budget) break;
    kept.push(hit);
    used += hit.chunk.tokenCount;
  }
  return kept;
}

const live = (hits: readonly SearchHit[]): SearchHit[] =>
  hits.filter((h) => h.chunk.amendmentStatus !== 'deleted');

function sectionIds(sections: readonly Section[]): Set<string> {
  return new Set([...walkSections(sections)].map((s) => s.id));
}

async function chunksFor(
  input: UnitContextInput,
  sections: readonly Section[],
): Promise<SearchHit[]> {
  const ids = sectionIds(sections);
  if (input.pool)
    return input.pool.filter((h) =>
      [h.chunk.sectionId, ...(h.chunk.coveredSectionIds ?? [])].some((id) =>
        ids.has(id),
      ),
    );
  return documentHits(input.backend, input.docId, sections, input.signal);
}

export async function buildUnitContext(
  input: UnitContextInput,
): Promise<UnitContext> {
  const { unit, doc, docId } = input;
  const own = withinBudget(
    live(await chunksFor(input, [unit])),
    UNIT_TOKEN_BUDGET,
  );
  const ownIds = sectionIds([unit]);

  // Definitions of the terms this part uses.
  let definitions: SearchHit[] = [];
  let usage = { embedTokens: 0, rerankUnits: 0 };
  if (input.pool) {
    const wanted = new Set(
      termsNeedingDefinitions(own).slice(0, MAX_INJECTED_DEFINITIONS),
    );
    definitions = live(input.pool).filter(
      (h) =>
        h.chunk.chunkType === 'definition' &&
        h.chunk.definesTerm !== undefined &&
        wanted.has(h.chunk.definesTerm),
    );
  } else {
    const found = await findDefinitionsToInject({
      backend: input.backend,
      docId,
      hits: own,
      includeDeleted: false,
      signal: input.signal,
    });
    definitions = live(found.definitions);
    usage = {
      embedTokens: found.usage.embedTokens,
      rerankUnits: found.usage.rerankUnits,
    };
  }

  // One hop of cross-references: sections this part names, not this part's own sections.
  const byId = new Map([...walkSections(doc.sections)].map((s) => [s.id, s]));
  const referred = [...new Set(own.flatMap((h) => h.chunk.refs))]
    .filter((id) => !ownIds.has(id) && byId.has(id))
    .slice(0, MAX_RELATED_SECTIONS);
  const related: SearchHit[] = [];
  for (const id of referred) {
    const section = byId.get(id);
    if (!section) continue;
    // Just that section (not its children), cut to a small budget.
    const chunks = (
      await chunksFor(input, [{ ...section, children: [] }])
    ).filter((h) => h.chunk.sectionId === id);
    related.push(...withinBudget(live(chunks), RELATED_TOKEN_BUDGET));
  }

  // Other laws read for this bill. Their excerpts cite the bill section that relies on them:
  // that is the real, openable source, and the bill is what makes the other law matter here.
  const references: SearchHit[] = [];
  for (const ref of doc.externalRefs) {
    if (references.length >= MAX_REFERENCE_TEXTS) break;
    const citing = ref.sectionIds.find((id) => ownIds.has(id));
    const text = doc.references?.find((r) => r.sectionId === ref.referenceId);
    if (!citing || !text) continue;
    references.push(
      syntheticHit(docId, {
        key: `reference:${String(references.length)}:${text.sectionId}`,
        sectionId: citing,
        breadcrumb: `Other law read for this bill: ${text.citation}${text.heading ? ` ${text.heading}` : ''}`,
        text: text.text.slice(0, REFERENCE_CHAR_BUDGET),
      }),
    );
  }

  return { hits: own, definitions, related, references, usage };
}

/** Everything a model may use for one part, in the order it should read it. */
export function unitExcerpts(context: UnitContext): SearchHit[] {
  return [
    ...context.hits,
    ...context.definitions,
    ...context.related,
    ...context.references,
  ];
}
