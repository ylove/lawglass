/**
 * Citation validation. The model may only cite sections we showed it; anything else is a
 * hallucinated source. This is security-relevant (see AGENTS.md), so it is small and heavily tested.
 */
import {
  CITATION_PATTERN,
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

/** Lowercase-free normal form: straight apostrophes, no quotes or emphasis marks, one space, no final period. */
function normalizeDecline(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/["\u201c\u201d*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '');
}

/** True when the whole reply is the decline sentence (formatting differences tolerated, extra words not). */
export function isDecline(text: string): boolean {
  return normalizeDecline(text) === normalizeDecline(DECLINE_TEXT);
}

/** Sections whose text is in this chunk: its own, plus small siblings merged under it. */
export function coveredSectionIds(c: StoredChunk): string[] {
  return c.coveredSectionIds ?? [c.sectionId];
}

/** Rewrite `[S:a, b]` and `[S:a; S:b]` as `[S:a] [S:b]` so each id is validated. */
function splitMultiMarkers(text: string, allowed: ReadonlySet<string>): string {
  // Scan each bracket-free body once; overlapping repeats around a separator backtrack quadratically.
  return text.replace(/\[S:([^[\]]*)\]/g, (whole, inner: string) => {
    if (!/[,;]/.test(inner)) return whole;
    // A section id that itself contains a comma or semicolon is one id, not several.
    if (allowed.has(inner)) return whole;
    const ids = inner.split(/[,;]/).map((s, i, parts) => {
      // Trim only beside separators: whitespace at the body's outer edges stays malformed.
      let trimmed = s;
      if (i > 0) trimmed = trimmed.trimStart();
      if (i < parts.length - 1) trimmed = trimmed.trimEnd();
      return trimmed.replace(/^S:/, '');
    });
    if (ids.some((id) => !id || /\s/.test(id))) return whole;
    return ids.map((id) => `[S:${id}]`).join(' ');
  });
}

/** Remove every marker for `id`, plus the space before it so "x [S:a]." becomes "x.". */
function stripMarker(text: string, id: string): string {
  const marker = `[S:${id}]`;
  const parts: string[] = [];
  let start = 0;
  for (
    let index = text.indexOf(marker);
    index !== -1;
    index = text.indexOf(marker, start)
  ) {
    // Search for the literal marker first so unrelated whitespace is never rescanned.
    let end = index;
    while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t'))
      end--;
    parts.push(text.slice(start, end));
    start = index + marker.length;
  }
  parts.push(text.slice(start));
  return parts.join('');
}

function buildCitation(sectionId: string, chunks: StoredChunk[]): Citation {
  const own = chunks.filter((c) => coveredSectionIds(c).includes(sectionId));
  const citation: Citation = {
    sectionId,
    valid: true,
    chunkIds: own.map((c) => c.id),
  };
  const first = own[0];
  if (first) citation.breadcrumb = first.breadcrumb;
  // Mirror the chunker's location(): the first line comes from chunks on the first page,
  // the last line from chunks on the last page.
  const pageStarts = own.flatMap((c) =>
    c.pageStart === undefined ? [] : [c.pageStart],
  );
  const pageEnds = own.flatMap((c) => {
    const p = c.pageEnd ?? c.pageStart;
    return p === undefined ? [] : [p];
  });
  const pageStart = pageStarts.length ? Math.min(...pageStarts) : undefined;
  const pageEnd = pageEnds.length ? Math.max(...pageEnds) : undefined;
  const firstLines = own.flatMap((c) =>
    c.lineStart !== undefined &&
    (pageStart === undefined || c.pageStart === pageStart)
      ? [c.lineStart]
      : [],
  );
  const lastLines = own.flatMap((c) => {
    const line = c.lineEnd ?? c.lineStart;
    return line !== undefined &&
      (pageEnd === undefined || (c.pageEnd ?? c.pageStart) === pageEnd)
      ? [line]
      : [];
  });
  const location: NonNullable<Citation['location']> = {};
  if (pageStart !== undefined) location.pageStart = pageStart;
  if (pageEnd !== undefined) location.pageEnd = pageEnd;
  if (firstLines.length) location.lineStart = Math.min(...firstLines);
  if (lastLines.length) location.lineEnd = Math.max(...lastLines);
  if (Object.keys(location).length) citation.location = location;
  return citation;
}

/**
 * @param text the model's full answer
 * @param retrievedSectionIds sections that were placed in the prompt
 * @param chunks the retrieved chunks, used for chunk ids, breadcrumbs and locations
 */
export function validateCitations(
  rawText: string,
  retrievedSectionIds: Iterable<string>,
  chunks: readonly StoredChunk[] = [],
): ValidatedAnswer {
  const allowed = new Set(retrievedSectionIds);
  // A cited value that is exactly a prompt chunk id means that chunk's section.
  const byChunkId = new Map(chunks.map((c) => [c.id, c.sectionId]));
  // A bare ordinal ("1") means the Nth excerpt in the prompt, which is the Nth chunk.
  const ordinals = new Map(
    chunks.map((c, i) => [String(i + 1), c.sectionId] as const),
  );
  const text = splitMultiMarkers(rawText, allowed).replace(
    new RegExp(CITATION_PATTERN.source, 'g'),
    (whole, id: string) => {
      const section =
        byChunkId.get(id) ?? (allowed.has(id) ? undefined : ordinals.get(id));
      return section === undefined ? whole : `[S:${section}]`;
    },
  );
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
