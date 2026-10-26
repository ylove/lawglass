import { validateCitations } from '../answer/citations.js';
import { fleschKincaidGrade } from '../answer/index.js';
import { hasAmendmentMarks } from '../chip-changes.js';
import { findExternalMatches } from '../enrich/refs.js';
import {
  sectionText,
  walkSections,
  type LocateLabel,
  type LocateResponse,
  type NormalizedDoc,
  type SearchHit,
  type Span,
} from '../model/index.js';
import type { Selection } from './prompt.js';

/** Matching only: keep an offset for each normalized character to recover source spelling. */
function normalized(text: string): {
  text: string;
  starts: number[];
  ends: number[];
} {
  const chars: string[] = [],
    starts: number[] = [],
    ends: number[] = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charAt(i);
    if (/\s/.test(c)) c = ' ';
    else if (/[‘’ʼ]/.test(c)) c = "'";
    else if (/[“”]/.test(c)) c = '"';
    else if (/[‐‑‒–—−]/.test(c)) c = '-';
    if (c === ' ' && chars.at(-1) === ' ') {
      ends[ends.length - 1] = i + 1;
      continue;
    }
    chars.push(c);
    starts.push(i);
    ends.push(i + 1);
  }
  return { text: chars.join(''), starts, ends };
}

export function verifyQuote(
  spans: readonly Span[],
  quote: string,
  requiredStatus?: Span['status'],
): Span[] {
  if (!quote.trim() || quote.trim().split(/\s+/).length > 60) return [];
  const source = normalized(spans.map((s) => s.text).join(''));
  const needle = normalized(quote.trim()).text;
  for (
    let at = source.text.indexOf(needle);
    at >= 0;
    at = source.text.indexOf(needle, at + 1)
  ) {
    const start = source.starts[at],
      end = source.ends[at + needle.length - 1];
    if (start === undefined || end === undefined) return [];
    let offset = 0;
    const parts = spans.flatMap((span) => {
      const from = Math.max(0, start - offset),
        to = Math.min(span.text.length, end - offset);
      offset += span.text.length;
      return to > from ? [{ ...span, text: span.text.slice(from, to) }] : [];
    });
    // Repeated words can occur in both retained and struck text. A deleted candidate may
    // only resolve to a deleted occurrence, never the first retained copy of those words.
    if (
      !requiredStatus ||
      parts.every((part) => !part.text.trim() || part.status === requiredStatus)
    )
      return parts;
  }
  return [];
}

/** Unchanged context does not cancel a change. Only both changed statuses mean changed. */
export function quoteLabel(
  spans: readonly Span[],
  marked: boolean,
): LocateLabel {
  const added = spans.some((s) => s.status === 'inserted'),
    removed = spans.some((s) => s.status === 'deleted');
  return added && removed
    ? 'changed'
    : added
      ? 'added'
      : removed
        ? 'removed'
        : marked
          ? 'existing'
          : 'in-bill';
}

export function verifySelection(
  selection: Selection,
  doc: NormalizedDoc,
  hits: readonly SearchHit[],
): Pick<
  LocateResponse,
  'status' | 'matches' | 'note' | 'noteCitations' | 'readingGrade'
> {
  const sections = new Map(
    [...walkSections(doc.sections)].map((s) => [s.id, s]),
  );
  const chunks = hits.map((h) => h.chunk);
  const allowed = chunks.flatMap((c) => c.coveredSectionIds ?? [c.sectionId]);
  const marked = hasAmendmentMarks(doc.sections);
  const matches: LocateResponse['matches'] = [];
  for (const selected of selection.notFound ? [] : selection.matches) {
    const chunk = hits[selected.passage - 1]?.chunk;
    if (!chunk) continue;
    for (const id of chunk.coveredSectionIds ?? [chunk.sectionId]) {
      const section = sections.get(id);
      if (!section || matches.some((m) => m.sectionId === id)) continue;
      const quote = verifyQuote(
        section.spans,
        selected.quote,
        chunk.amendmentStatus === 'deleted' ? 'deleted' : undefined,
      );
      if (!quote.length) continue;
      const checked = validateCitations(selected.explanation, allowed, chunks);
      const valid = checked.citations.filter((c) => c.valid);
      const fallback = validateCitations(
        `[S:${id}]`,
        allowed,
        chunks,
      ).citations.filter((c) => c.valid);
      const text = sectionText(section, { includeDeleted: false });
      const amends = /\b(?:amend(?:ed|s)?|striking|inserting)\b/i.test(text)
        ? findExternalMatches(text).find(
            (r) => r.kind === 'us_code' || /Act\b/i.test(r.text),
          )?.citation
        : undefined;
      const conditions = selected.conditions
        ? validateCitations(selected.conditions, allowed, chunks).text
        : undefined;
      matches.push({
        sectionId: id,
        breadcrumb: chunk.breadcrumb,
        quote,
        label: quoteLabel(quote, marked),
        explanation: valid.length ? checked.text : `${checked.text} [S:${id}]`,
        citations: valid.length ? valid : fallback,
        ...(conditions ? { conditions } : {}),
        ...(amends ? { amends } : {}),
        location: {
          ...Object.fromEntries(
            Object.entries({
              pageStart: quote[0]?.page ?? chunk.pageStart ?? section.pageStart,
              pageEnd: quote.at(-1)?.page ?? chunk.pageEnd ?? section.pageEnd,
              lineStart: quote[0]?.line ?? chunk.lineStart ?? section.lineStart,
              lineEnd: quote.at(-1)?.line ?? chunk.lineEnd ?? section.lineEnd,
            }).filter(([, value]) => value !== undefined),
          ),
        },
      });
      break;
    }
    if (matches.length === 3) break;
  }
  const note = validateCitations(selection.note ?? '', allowed, chunks);
  const noteCitations = note.citations.filter((c) => c.valid);
  return {
    status: matches.length ? 'found' : 'not-found',
    matches,
    ...(!matches.length && noteCitations.length
      ? { note: note.text, noteCitations }
      : {}),
    readingGrade: fleschKincaidGrade(
      matches.map((m) => m.explanation).join(' '),
    ),
  };
}
