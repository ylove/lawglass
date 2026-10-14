/**
 * The subject of a bill's default scenario (spec amendment 17). Chosen without a model, so the
 * same document and summary always give the same subject, and so the scenario cache entry for
 * it is stable.
 */
import type {
  AnswerResult,
  NormalizedDoc,
  Section,
} from '../core/model/index.js';
import { scenarioPersonasFor } from './doc-detail.js';

/** Used when no group can be read from the bill. Passes the same subject checks as a reader's. */
export const NEUTRAL_SUBJECT = 'a resident';

function findSection(
  sections: readonly Section[],
  id: string,
): Section | undefined {
  for (const section of sections) {
    if (section.id === id) return section;
    const inChild = findSection(section.children, id);
    if (inChild) return inChild;
  }
  return undefined;
}

/** Section cited most often by valid citations; the earliest citation wins a tie. */
function mostCitedSectionId(summary: AnswerResult): string | undefined {
  const counts = new Map<string, number>();
  for (const citation of summary.citations)
    if (citation.valid)
      counts.set(citation.sectionId, (counts.get(citation.sectionId) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  // Map iteration is insertion order, so a strict `>` keeps the earliest on ties.
  for (const [id, count] of counts)
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  return best;
}

/**
 * 1. The first group the summary's most-cited section affects.
 * 2. Else the first group the whole bill affects.
 * 3. Else a neutral resident.
 */
export function defaultScenarioSubject(
  doc: NormalizedDoc,
  summary?: AnswerResult,
): string {
  const citedId = summary ? mostCitedSectionId(summary) : undefined;
  const cited = citedId ? findSection(doc.sections, citedId) : undefined;
  if (cited) {
    // Without the title, so the group comes from the section itself, not the whole bill.
    const personas = scenarioPersonasFor({
      ...doc,
      metadata: { ...doc.metadata, title: null },
      sections: [cited],
    });
    if (personas[0]) return personas[0];
  }
  return scenarioPersonasFor(doc)[0] ?? NEUTRAL_SUBJECT;
}
