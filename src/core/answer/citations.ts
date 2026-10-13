/**
 * Citation validation. The model may only cite sections we showed it; anything else is a
 * hallucinated source. This is security-relevant (see AGENTS.md), so it is small and heavily tested.
 */
import {
  DECLINE_TEXT,
  findCitationIds,
  type AnswerWarning,
  type Citation,
  type StoredChunk,
} from '../model/index.js';

export interface ValidatedAnswer {
  /** Text with invalid markers removed. */
  text: string;
  citations: Citation[];
  /** Invalid section ids, unique, in order of first appearance. */
  invalidCitations: string[];
  warnings: AnswerWarning[];
  declined: boolean;
}

export function isDecline(text: string): boolean {
  return text.trim() === DECLINE_TEXT;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Remove every marker for `id`, plus the space before it so "x [S:a]." becomes "x.". */
function stripMarker(text: string, id: string): string {
  return text.replace(
    new RegExp(`[ \\t]*\\[S:${escapeRegExp(id)}\\]`, 'g'),
    '',
  );
}

function span(values: (number | undefined)[], pick: 'min' | 'max') {
  const nums = values.filter((v): v is number => v !== undefined);
  return nums.length ? Math[pick](...nums) : undefined;
}

function buildCitation(sectionId: string, chunks: StoredChunk[]): Citation {
  const own = chunks.filter((c) => c.sectionId === sectionId);
  const citation: Citation = {
    sectionId,
    valid: true,
    chunkIds: own.map((c) => c.id),
  };
  const first = own[0];
  if (first) citation.breadcrumb = first.breadcrumb;
  const pageStart = span(
    own.map((c) => c.pageStart),
    'min',
  );
  const pageEnd = span(
    own.map((c) => c.pageEnd ?? c.pageStart),
    'max',
  );
  const lineStart = span(
    own.map((c) => c.lineStart),
    'min',
  );
  const lineEnd = span(
    own.map((c) => c.lineEnd ?? c.lineStart),
    'max',
  );
  const location: NonNullable<Citation['location']> = {};
  if (pageStart !== undefined) location.pageStart = pageStart;
  if (pageEnd !== undefined) location.pageEnd = pageEnd;
  if (lineStart !== undefined) location.lineStart = lineStart;
  if (lineEnd !== undefined) location.lineEnd = lineEnd;
  if (Object.keys(location).length) citation.location = location;
  return citation;
}

/**
 * @param text the model's full answer
 * @param retrievedSectionIds sections that were placed in the prompt
 * @param chunks the retrieved chunks, used for chunk ids, breadcrumbs and locations
 */
export function validateCitations(
  text: string,
  retrievedSectionIds: Iterable<string>,
  chunks: readonly StoredChunk[] = [],
): ValidatedAnswer {
  const allowed = new Set(retrievedSectionIds);
  const declined = isDecline(text);
  const cited = [...new Set(findCitationIds(text))];

  const invalidCitations = cited.filter((id) => !allowed.has(id));
  let cleaned = text;
  for (const id of invalidCitations) cleaned = stripMarker(cleaned, id);
  if (invalidCitations.length)
    cleaned = cleaned.replace(/[ \t]{2,}/g, ' ').trim();

  const chunkList = [...chunks];
  const citations: Citation[] = cited.map((id) =>
    allowed.has(id)
      ? buildCitation(id, chunkList)
      : { sectionId: id, valid: false, chunkIds: [] },
  );

  const warnings: AnswerWarning[] = [];
  if (!declined && citations.every((c) => !c.valid))
    warnings.push('NO_VALID_CITATIONS');
  if (invalidCitations.length) warnings.push('INVALID_CITATIONS_REMOVED');

  return { text: cleaned, citations, invalidCitations, warnings, declined };
}
