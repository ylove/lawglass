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

/** Which spans the model was shown: live text for a live chunk, struck text for a deleted one. */
export type QuoteView = 'live' | 'deleted' | 'all';

/** Only the chunk's printed range can disambiguate repeated wording; all fields are optional. */
export interface QuoteRange {
  pageStart?: number | undefined;
  pageEnd?: number | undefined;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}

const MIN_QUOTE_CHARS = 12;
const MIN_QUOTE_WORDS = 3;
const isWordChar = (c: string | undefined): boolean =>
  c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** The model is told markers are metadata, but strip them if it copies them anyway. */
const MARKER_TAGS = /\[\/?(?:struck|inserted)\]/gi;

function inRange(part: Span, range: QuoteRange | undefined): boolean {
  if (!range) return true;
  const within = (v: number | undefined, lo?: number, hi?: number): boolean =>
    v === undefined ||
    lo === undefined ||
    (v >= lo && (hi === undefined || v <= hi));
  return (
    within(part.page, range.pageStart, range.pageEnd) &&
    within(part.line, range.lineStart, range.lineEnd)
  );
}

const hasText = (s: Span): boolean => s.text.trim().length > 0;

/**
 * Copy `quote` out of the section as spans. The quote is matched against the text the model
 * actually saw (`view`), then mapped back onto the real spans:
 *  - `live`: unchanged + inserted words. Struck words that sit between matched words are kept
 *    in `quote` with status `deleted`, so the label becomes `changed` and the receipt reads
 *    `[removed: ...]`. Struck words outside the match are never included.
 *  - `deleted`: only struck words; a quote of a struck candidate never resolves to a live copy.
 * Repeated wording resolves to the first occurrence inside the chunk's printed range, else the first.
 */
export function verifyQuote(
  spans: readonly Span[],
  quote: string,
  view: QuoteView = 'all',
  range?: QuoteRange,
): Span[] {
  const cleaned = quote.replace(MARKER_TAGS, '').trim();
  if (!cleaned || cleaned.split(/\s+/).length > 60) return [];
  const included = spans
    .map((span, index) => ({ span, index }))
    .filter(({ span }) =>
      view === 'live'
        ? span.status !== 'deleted'
        : view === 'deleted'
          ? span.status === 'deleted'
          : true,
    );
  const source = normalized(included.map((i) => i.span.text).join(''));
  const needle = normalized(cleaned).text;
  // A fragment such as "a" or "ees shall" proves nothing; allow short text only when it is
  // the whole passage.
  const short =
    needle.length < MIN_QUOTE_CHARS &&
    needle.split(' ').length < MIN_QUOTE_WORDS;
  if (short && needle !== source.text.trim()) return [];
  const matches: Span[][] = [];
  for (
    let at = source.text.indexOf(needle);
    at >= 0;
    at = source.text.indexOf(needle, at + 1)
  ) {
    const first = needle.charAt(0),
      last = needle.charAt(needle.length - 1);
    if (
      (isWordChar(first) && isWordChar(source.text[at - 1])) ||
      (isWordChar(last) && isWordChar(source.text[at + needle.length]))
    )
      continue;
    const start = source.starts[at],
      end = source.ends[at + needle.length - 1];
    if (start === undefined || end === undefined) return [];
    let offset = 0;
    const picked: { span: Span; index: number }[] = [];
    for (const { span, index } of included) {
      const from = Math.max(0, start - offset),
        to = Math.min(span.text.length, end - offset);
      offset += span.text.length;
      if (to > from)
        picked.push({
          span: { ...span, text: span.text.slice(from, to) },
          index,
        });
    }
    const lo = picked[0]?.index,
      hi = picked.at(-1)?.index;
    if (lo === undefined || hi === undefined) continue;
    // In live view, struck words between the first and last matched span belong to the edit.
    const parts =
      view === 'live'
        ? spans.flatMap((span, index) => {
            if (index < lo || index > hi) return [];
            const match = picked.find((p) => p.index === index);
            return match
              ? [match.span]
              : span.status === 'deleted'
                ? [span]
                : [];
          })
        : picked.map((p) => p.span);
    matches.push(parts);
  }
  return (
    matches.find((m) => m.every((p) => inRange(p, range))) ?? matches[0] ?? []
  );
}

/** Unchanged context does not cancel a change. Only both changed statuses mean changed. */
export function quoteLabel(
  spans: readonly Span[],
  marked: boolean,
): LocateLabel {
  // Whitespace between words carries no wording, so a stray struck space is not a removal.
  const real = spans.filter(hasText);
  const added = real.some((s) => s.status === 'inserted'),
    removed = real.some((s) => s.status === 'deleted');
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

/**
 * "Never a verdict" backstop. The prompt asks for neutral wording; this makes it deterministic.
 * Words inside a double-quoted phrase that really occurs in the bill are exempt, so a bill's own
 * "false statement" can be quoted.
 */
const VERDICT =
  /\b(?:true|untrue|false|correct(?:ly)?|incorrect(?:ly)?|accurate(?:ly)?|inaccurate(?:ly)?|misleading|misinformation|myth|fact[- ]?check\w*|debunk\w*)\b|\b(?:the|this|that|your)\s+(?:claim|statement|sentence)\s+(?:is|was|isn't|is not)\b/i;

export function hasVerdictLanguage(text: string, billText: string): boolean {
  const bill = normalized(billText).text.toLowerCase();
  const unquoted = text.replace(
    /["“]([^"“”]{1,200})["”]/g,
    (whole, inner: string) =>
      bill.includes(normalized(inner).text.toLowerCase()) ? ' ' : whole,
  );
  return VERDICT.test(unquoted);
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
        // Match what the model saw: struck text for a deleted chunk, live text otherwise.
        chunk.amendmentStatus === 'deleted' ? 'deleted' : 'live',
        chunk,
      );
      if (!quote.length) continue;
      const billText = sectionText(section, { includeDeleted: true });
      const neutral = hasVerdictLanguage(selected.explanation, billText);
      const checked = validateCitations(
        neutral
          ? `This passage is in ${chunk.breadcrumb}.`
          : selected.explanation,
        allowed,
        chunks,
      );
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
      const conditions =
        selected.conditions &&
        !hasVerdictLanguage(selected.conditions, billText)
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
  const allBill = hits
    .flatMap((h) => h.chunk.coveredSectionIds ?? [h.chunk.sectionId])
    .map((id) => sections.get(id))
    .map((section) =>
      section ? sectionText(section, { includeDeleted: true }) : '',
    )
    .join(' ');
  const note = validateCitations(
    selection.note && !hasVerdictLanguage(selection.note, allBill)
      ? selection.note
      : '',
    allowed,
    chunks,
  );
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
