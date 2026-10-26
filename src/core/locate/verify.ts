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
  /** The chunk's own text, a verbatim slice of the section the model saw. */
  text?: string | undefined;
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
  const matches: { parts: Span[]; at: number }[] = [];
  for (
    let at = source.text.indexOf(needle);
    at >= 0;
    at = source.text.indexOf(needle, at + 1)
  ) {
    // Never start or end inside a word, even when the quote itself starts with punctuation
    // ("-shall report" inside "employees-shall report").
    if (
      isWordChar(source.text[at - 1]) ||
      isWordChar(source.text[at + needle.length])
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
    // Deleted view: the model saw each struck run as its own passage, so a quote must sit in
    // one run. Separate runs (live words between them) must not be stitched into a new phrase.
    if (
      view === 'deleted' &&
      picked.some((p, i) => {
        const prev = picked[i - 1];
        return (
          prev !== undefined &&
          spans.slice(prev.index + 1, p.index).some(hasText)
        );
      })
    )
      continue;
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
    matches.push({ parts, at });
  }
  // Repeated wording: prefer the copy inside the chunk's own text, then its printed range.
  const chunk = range?.text ? normalized(range.text.trim()).text : '';
  const window = chunk ? source.text.indexOf(chunk) : -1;
  const inWindow = (m: { at: number }): boolean =>
    window >= 0 && m.at >= window && m.at < window + chunk.length;
  const ranged = (m: { parts: Span[] }): boolean =>
    m.parts.every((p) => inRange(p, range));
  const best =
    matches.find((m) => inWindow(m) && ranged(m)) ??
    matches.find(inWindow) ??
    matches.find(ranged) ??
    matches[0];
  return best?.parts ?? [];
}

/** Label from what the quote shows: all struck is removed; struck plus live is changed. */
export function quoteLabel(
  spans: readonly Span[],
  marked: boolean,
): LocateLabel {
  // Whitespace between words carries no wording, so a stray struck space is not a removal.
  const real = spans.filter(hasText);
  const added = real.some((s) => s.status === 'inserted'),
    removed = real.some((s) => s.status === 'deleted'),
    current = real.some((s) => s.status !== 'deleted');
  // `removed` only when every quoted word is struck. Live words around a struck gap are
  // current text that the bill edits, so the quote is `changed`, never `removed`.
  return removed && current
    ? 'changed'
    : removed
      ? 'removed'
      : added
        ? 'added'
        : marked
          ? 'existing'
          : 'in-bill';
}

/**
 * "Never a verdict" backstop. The prompt asks for neutral wording; this makes it deterministic.
 * Words inside a double-quoted phrase that really occurs in the bill are exempt, so a bill's own
 * "false statement" can be quoted.
 *
 * Two lists: wording that only ever judges the reader's sentence ("the claim is", "misleading"),
 * and words that are verdicts in a claim check but ordinary in law ("confirm the nominee",
 * "jurisdiction lies with", "a true copy", "jury verdict"). An ambiguous word is allowed when the
 * matched section itself uses it (#312); a strict phrase never is.
 */
const VERDICT =
  /\b(?:untrue|incorrect(?:ly)?|inaccurate(?:ly)?|misleading|misinformation|myth|wrong|fact[- ]?check\w*|debunk\w*)\b|\b(?:the|this|that|your)\s+(?:claim|statement|sentence)\s+(?:is|was|isn't|is not)\b|\bmatches\s+(?:the\s+)?(?:bill|claim|sentence)\b|\bbacks?\s+(?:this|that|it)\s+up\b|^\s*(?:yes|no),|["“]\s*(?:true|false|correct|accurate|right)\s*["”]/;

/**
 * Verdict words that are also ordinary legal vocabulary, as whole-word families. A family is the
 * word's inflections only: never a bare prefix, which would let "lien" vouch for "lies".
 */
const AMBIGUOUS_FAMILIES: readonly (readonly string[])[] = [
  ['true'],
  ['false', 'falsely'],
  ['correct', 'corrects', 'corrected', 'correcting', 'correctly'],
  ['accurate', 'accurately'],
  ['lie', 'lies'],
  ['verdict', 'verdicts'],
  ['confirm', 'confirms', 'confirmed', 'confirming'],
];
const FAMILY_OF = new Map(
  AMBIGUOUS_FAMILIES.flatMap((family) => family.map((w) => [w, family])),
);

/** Words too common to show how a word is used: every section has "is true" or "and correct". */
const FUNCTION_WORDS = new Set(
  (
    'a an the and or nor but not no of to in on at by for with from about as if than then so ' +
    'that this these those it its is are was were be been being am do does did has have had ' +
    'will would can could should shall may might must i you your we our they their he his she her ' +
    'there here which who whom what'
  ).split(' '),
);
const contentWords = (folded: string): string[] =>
  folded.split(' ').filter((w) => w !== '' && !FUNCTION_WORDS.has(w));

/**
 * An ambiguous word is legal vocabulary, not a verdict, only when the explanation uses it the
 * way the section does: the word (any inflection) beside the same content word, function words
 * skipped. "Confirm the nominee" passes on "shall confirm the nominee"; "This is true" fails even
 * on "the certificate is true". A neighbour that is itself ambiguous never vouches ("true and
 * correct").
 */
function usedAsInBill(
  words: readonly string[],
  i: number,
  billContent: string,
): boolean {
  const family = FAMILY_OF.get(words[i] ?? '') ?? [];
  const neighbour = (w: string | undefined): w is string =>
    w !== undefined && !FAMILY_OF.has(w);
  const before = words[i - 1];
  const after = words[i + 1];
  return family.some(
    (form) =>
      (neighbour(before) && billContent.includes(` ${before} ${form} `)) ||
      (neighbour(after) && billContent.includes(` ${form} ${after} `)),
  );
}

/** Look-alike letters that would hide a verdict word from the check. */
const CONFUSABLES: Record<string, string> = Object.fromEntries(
  Object.entries({
    a: 'аα',
    e: 'еε',
    o: 'оο',
    p: 'рρ',
    c: 'с',
    y: 'у',
    x: 'хχ',
    k: 'кκ',
    t: 'тτ',
    h: 'н',
    b: 'в',
    m: 'м',
    i: 'іι',
    j: 'ј',
    s: 'ѕ',
    u: 'υ',
    v: 'ν',
  }).flatMap(([latin, others]) => Array.from(others).map((c) => [c, latin])),
);

/** NFKC, no invisible characters, look-alikes folded to Latin, lower case. For checking only. */
function fold(text: string): string {
  return Array.from(
    text
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .toLowerCase(),
  )
    .map((c) => CONFUSABLES[c] ?? c)
    .join('');
}
const wordsOf = (text: string): string =>
  ` ${fold(text)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;

export function hasVerdictLanguage(text: string, billText: string): boolean {
  const bill = wordsOf(billText);
  // A quoted phrase is exempt only when it is two or more whole words that occur in the bill.
  const unquoted = fold(text).replace(
    /["“]([^"“”]{1,200})["”]/g,
    (whole, inner: string) => {
      const phrase = wordsOf(inner);
      return phrase.trim().includes(' ') && bill.includes(phrase) ? ' ' : whole;
    },
  );
  if (VERDICT.test(unquoted)) return true;
  // An ambiguous word passes only when the section uses it with the same neighbour (#312).
  const billContent = ` ${contentWords(bill).join(' ')} `;
  const words = contentWords(wordsOf(unquoted));
  return words.some(
    (word, i) => FAMILY_OF.has(word) && !usedAsInBill(words, i, billContent),
  );
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
