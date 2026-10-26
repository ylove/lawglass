/**
 * Definitions that a bill borrows from the U.S. Code.
 *
 * Federal bills often define a term by pointing at other law: "the term 'financial
 * institution' has the meaning given that term in section 509 of the Gramm-Leach-Bliley Act
 * (15 U.S.C. 6809)". The bill alone cannot answer "what is a financial institution?", so these
 * pointers are found here and the cited section is read from the official source later
 * (`references.ts`). Detection is deliberately narrow: a pointer is only followed when a
 * U.S. Code citation sits right after a "meaning"/"defined in" phrase in the same clause.
 */
import {
  sectionText,
  walkSections,
  type Definition,
  type Section,
} from '../model/index.js';
import { segmentDefinitions } from './definitions.js';
import { findExternalMatches } from './refs.js';

/** One term of the bill that a U.S. Code section is read for. */
export interface BorrowedTerm {
  /** The term as the bill uses it (for a guessed term, its best guess). */
  term: string;
  /**
   * What to look for in the cited section, best first. A pointer such as "the meaning given the
   * term State depository institution in section 3" names the target's own wording.
   */
  lookups: string[];
  /**
   * True when the bill states the term outright. False when it was guessed from the words
   * before "(as defined in ...)": a guess that the cited section does not define is dropped.
   */
  stated: boolean;
  /** Designators of the subsection the bill cites, e.g. ["k"] for "12 U.S.C. 1843(k)". */
  subsection?: string[];
}

export interface DefinitionTarget {
  title: number;
  section: string;
  /** Normalized citation, matching `ExternalRef.citation`. */
  citation: string;
  terms: BorrowedTerm[];
}

export const MAX_TARGETS = 8;
const MAX_TERMS_PER_TARGET = 8;
/** How far after a phrase to look for the citation it points to. */
const WINDOW = 320;
/** The citation must start this close to the phrase, or it belongs to something else. */
const MAX_GAP = 180;
/** Words before "(as defined in ...)" tried as the term, longest first. */
const MAX_GUESS_WORDS = 5;

const MEANING = /\b(?:has|have)\s+the\s+(?:same\s+)?meanings?\b/gi;
// Directly after MEANING: "given that term in", "given the term State bank in", "as in".
// The named form keeps the rest of the clause; `givenTerm` finds where "in/under/by" starts.
const NAMED_GIVEN =
  /^\s+(?:as\s+)?given\s+(?:to\s+)?(?:that|such|the)\s+term\b([^,;.()—]{0,70})/i;
const PLAIN_GIVEN =
  /^\s+(?:(?:as\s+)?(?:given|defined|assigned)\s+(?:in|under|by)\b|as\s+in\b|in\b|under\b)/i;
const LINKING_WORDS = new Set(['in', 'under', 'by']);

/**
 * Whether `after` (the text following "has the meaning") points somewhere, and the target's own
 * name for the term when it gives one ("given the term State depository institution in ...").
 */
function givenTerm(after: string): { pointer: boolean; named?: string } {
  const named = NAMED_GIVEN.exec(after);
  if (named) {
    const words = (named[1] ?? '').trim().split(/\s+/).filter(Boolean);
    const at = words.findIndex((w) => LINKING_WORDS.has(w.toLowerCase()));
    if (at === -1) return { pointer: false };
    return at === 0
      ? { pointer: true }
      : { pointer: true, named: words.slice(0, at).join(' ') };
  }
  return { pointer: PLAIN_GIVEN.test(after) };
}

const AS_DEFINED =
  /\(?\b(?:as\s+defined\s+(?:in|under|by)|within\s+the\s+meaning\s+(?:given\s+)?(?:of|in|under))\s+/gi;
// Words that end a noun phrase when read backwards from "(as defined in ...)".
const PHRASE_BREAKERS = new Set(
  'a an the any each such that this these those is are was were be been and or for by with to in on under which who whose if as not no all'.split(
    ' ',
  ),
);
// A pointer ends at the first of these; the citation must come before it.
const CLAUSE_BREAK = /[;—:]/;

function uscMatchIn(
  window: string,
  maxGap: number,
): { title: number; section: string; subsection: string[] } | undefined {
  const match = findExternalMatches(window).find(
    (m) => m.kind === 'us_code' && /^\d/.test(m.citation),
  );
  if (!match || match.start > maxGap) return undefined;
  if (CLAUSE_BREAK.test(window.slice(0, match.start))) return undefined;
  const m = /^(\d{1,2}) U\.S\.C\. (\S+)/.exec(match.citation);
  if (!m) return undefined;
  // "(k)" or "(c)(2)" right after the section number names the part of it the bill means.
  const designators =
    /^(?:\([A-Za-z0-9]+\))+/.exec(window.slice(match.end))?.[0] ?? '';
  const subsection = [...designators.matchAll(/\(([A-Za-z0-9]+)\)/g)].map(
    (d) => d[1] ?? '',
  );
  return { title: Number(m[1]), section: m[2] ?? '', subsection };
}

/** `text` without trailing characters from `chars`. A loop: a `+$` regex is quadratic on long runs. */
function stripTrailing(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text.charAt(end - 1))) end--;
  return text.slice(0, end);
}

/** Index of the last character that ends a noun phrase, or -1. */
function lastBreak(text: string): number {
  let at = -1;
  for (const mark of ',;:()—.') at = Math.max(at, text.lastIndexOf(mark));
  return at;
}

/** The noun phrase just before `at`, as candidate terms, longest first ("insured depository institution", "depository institution", ...). */
function guessTerms(text: string, at: number): string[] {
  const before = stripTrailing(
    text.slice(Math.max(0, at - 120), at),
    ' \t\n,(',
  );
  // Only the clause the phrase sits in: stop at punctuation that ends a noun phrase.
  const clause = before.slice(lastBreak(before) + 1);
  const words = clause.trim().split(/\s+/).filter(Boolean);
  const phrase: string[] = [];
  for (
    let i = words.length - 1;
    i >= 0 && phrase.length < MAX_GUESS_WORDS;
    i--
  ) {
    const word = words[i] ?? '';
    if (PHRASE_BREAKERS.has(word.toLowerCase())) break;
    phrase.unshift(word);
  }
  const guesses: string[] = [];
  for (let n = phrase.length; n >= 1; n--)
    guesses.push(phrase.slice(-n).join(' '));
  return guesses;
}

/** The term a definition clause at `at` is for: the segment it sits in, else "the term X" just before. */
function termAt(
  text: string,
  segments: ReturnType<typeof segmentDefinitions>,
  at: number,
): string | undefined {
  const segment = segments.find((s) => s.start <= at && at < s.end);
  if (segment) return segment.term;
  const before = text.slice(Math.max(0, at - 160), at);
  // "the term X" directly before the clause, possibly quoted and followed by a dash or a label.
  const start = before.toLowerCase().lastIndexOf('the term ');
  if (start === -1) return undefined;
  const tail = before.slice(start + 'the term '.length).replace(/^["“]/, '');
  const end = tail.search(/["”,.;:()—]/);
  const term = (end === -1 ? tail : tail.slice(0, end)).trim();
  return term && term.length <= 60 ? term : undefined;
}

/** U.S. Code sections the bill's definitions and "(as defined in ...)" asides point to. */
export function findDefinitionTargets(
  sections: readonly Section[],
  definitions: readonly Definition[],
): DefinitionTarget[] {
  const byKey = new Map<string, DefinitionTarget>();
  const add = (
    cite: { title: number; section: string; subsection: string[] },
    term: BorrowedTerm,
  ): void => {
    if (cite.subsection.length > 0)
      term = { ...term, subsection: cite.subsection };
    const key = `${String(cite.title)}/${cite.section}`;
    let target = byKey.get(key);
    if (!target) {
      target = {
        title: cite.title,
        section: cite.section,
        citation: `${String(cite.title)} U.S.C. ${cite.section}`,
        terms: [],
      };
      byKey.set(key, target);
    }
    if (
      target.terms.some((t) => t.term.toLowerCase() === term.term.toLowerCase())
    )
      return;
    target.terms.push(term);
  };

  // "The term X has the meaning given that term in section N of the Y Act (T U.S.C. S)".
  const scanMeaning = (
    text: string,
    termFor: (at: number) => string | undefined,
  ): void => {
    for (const m of text.matchAll(MEANING)) {
      const term = termFor(m.index);
      if (term === undefined) continue;
      const after = text.slice(
        m.index + m[0].length,
        m.index + m[0].length + WINDOW,
      );
      const given = givenTerm(after);
      if (!given.pointer) continue;
      const cite = uscMatchIn(after, MAX_GAP);
      if (!cite) continue;
      const named = given.named;
      add(cite, {
        term,
        lookups:
          named && named.toLowerCase() !== term.toLowerCase()
            ? [named, term]
            : [term],
        stated: true,
      });
    }
  };
  // The definitions found at enrichment, then the text itself: a definition that shares a line
  // with others is not always split out, and the pointer is still plain in the section text.
  for (const definition of definitions)
    scanMeaning(definition.text, () => definition.term);

  // "a deposit (as defined in section 3 of the Federal Deposit Insurance Act (12 U.S.C. 1813))".
  for (const section of walkSections(sections)) {
    const text = sectionText(section, { includeDeleted: false });
    const segments = segmentDefinitions(text);
    scanMeaning(text, (at) => termAt(text, segments, at));
    for (const m of text.matchAll(AS_DEFINED)) {
      const rest = text.slice(
        m.index + m[0].length,
        m.index + m[0].length + WINDOW,
      );
      const cite = uscMatchIn(rest, MAX_GAP);
      if (!cite) continue;
      const guesses = guessTerms(text, m.index);
      const best = guesses[0];
      if (best === undefined) continue;
      add(cite, { term: best, lookups: guesses, stated: false });
    }
  }

  return [...byKey.values()]
    .map((target) => ({
      ...target,
      terms: target.terms.slice(0, MAX_TERMS_PER_TARGET),
    }))
    .map((target, order) => ({ target, order }))
    .sort(
      (a, b) =>
        b.target.terms.filter((t) => t.stated).length -
          a.target.terms.filter((t) => t.stated).length || a.order - b.order,
    )
    .slice(0, MAX_TARGETS)
    .map(({ target }) => target);
}
