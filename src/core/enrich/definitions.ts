import { sectionText, type Definition, type Section } from '../model/index.js';
import {
  ancestry,
  buildSectionIndex,
  enclosingSection,
  type SectionIndex,
} from './section-index.js';

/** One definition found inside a run of text. `start`/`end` index into that text. */
export interface DefinitionSegment {
  term: string;
  start: number;
  end: number;
}

// "has the meaning given" and Ohio's "has the same meaning as in section X of the Revised Code".
const VERBS =
  '(?:means?|includes?|shall\\s+mean|(?:shall\\s+)?(?:has|have)\\s+the\\s+(?:same\\s+)?meanings?|refers?\\s+to)';
// "X" means / the term "X" means (straight or curly quotes).
const QUOTED = new RegExp(
  `(?:\\bthe\\s+term\\s+)?["“]([^"“”]{1,80}?)["”]\\s+${VERBS}\\b`,
  'giu',
);
// the term X means (no quotes). Quote characters are excluded so QUOTED owns those.
const UNQUOTED = new RegExp(
  `\\bthe\\s+term\\s+([^,.;:"“”()\\n]{1,60}?)\\s+${VERBS}\\b`,
  'giu',
);

// Directly before a match: "In this section, " / "As used in this chapter:".
const LEAD_IN =
  /(?:as\s+used\s+in|for\s+(?:the\s+)?purposes?\s+of|in)\s+(?:this|the|sections?|divisions?|chapters?)[^.,:;\n]{0,80}[,:]\s*$/i;
// Before the lead-in/match: "(A) ", "(1) In general.—", "Administrator.—".
const LABEL =
  /(?:(?:\([A-Za-z0-9]{1,6}\)\s*)+)?(?:[^.\n()—–]{1,60}\.\s*[—–-]{1,2}\s*)?$/;
const SENTENCE_BREAK = /(?:^|\n|[.;:!?]["”’)]*|—)\s*$/;

// How far back from a match the lead-in and label can reach. Bounded so the cost of finding
// a definition's start depends on the definition, not on the size of the section.
const LOOKBEHIND = 200;
const LEAD_IN_MAX = 130;
const LABEL_MAX = 90;

/**
 * Where the definition containing a match begins, or undefined when the match sits in the
 * middle of a sentence ("... the word "x" means ..." in operative text is not a definition).
 */
function segmentStart(text: string, matchIndex: number): number | undefined {
  const from = Math.max(0, matchIndex - LOOKBEHIND);
  let rest = text.slice(from, matchIndex);
  // The lead-in and the label both end at the match, so only their possible length matters.
  const lead = LEAD_IN.exec(rest.slice(-LEAD_IN_MAX));
  if (lead) rest = rest.slice(0, rest.length - lead[0].length);
  const tail = rest.slice(-LABEL_MAX);
  const label = LABEL.exec(tail);
  if (label && label[0].length > 0)
    rest = rest.slice(0, rest.length - tail.length + label.index);
  return SENTENCE_BREAK.test(rest) ? from + rest.trimEnd().length : undefined;
}

export function normalizeTerm(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
}

type LabelClass = 'upper' | 'lower' | 'digit';

function labelClass(label: string): LabelClass | undefined {
  if (/^\d+$/.test(label)) return 'digit';
  if (/^[A-Z]+$/.test(label)) return 'upper';
  if (/^[a-z]+$/.test(label)) return 'lower';
  return undefined;
}

const OWN_LABEL = /^\s*\(([A-Za-z0-9]{1,6})\)/;
const ANY_LABEL = /(?:^|\n|[.;:!?]["”’)]*)\s*\(([A-Za-z0-9]{1,6})\)\s/g;

/**
 * Where a definition stops short of the next definition: at the next sibling label ("(C)"
 * after "(B)") that is not itself a definition, or, for an unlabeled one, at a blank line.
 * Without this the last definition in a run would swallow the operative text after it.
 */
function definitionEnd(text: string, start: number, limit: number): number {
  const body = text.slice(start, limit);
  const own = OWN_LABEL.exec(body);
  const cls = own ? labelClass(own[1] ?? '') : undefined;
  if (own && cls) {
    ANY_LABEL.lastIndex = own[0].length;
    for (const m of body.matchAll(ANY_LABEL)) {
      if (m.index + m[0].length <= own[0].length) continue;
      if (labelClass(m[1] ?? '') === cls) {
        const at = body.indexOf('(', m.index);
        return start + at;
      }
    }
    return limit;
  }
  const blank = /\n[ \t]*\n/.exec(body);
  return blank ? start + blank.index : limit;
}

/** Splits text into its definitions, in order. Text before the first one is the preamble. */
export function segmentDefinitions(text: string): DefinitionSegment[] {
  const candidates = [...text.matchAll(QUOTED), ...text.matchAll(UNQUOTED)]
    .sort((a, b) => a.index - b.index)
    .flatMap((match) => {
      const term = normalizeTerm(match[1] ?? '');
      const start = segmentStart(text, match.index);
      return term && start !== undefined ? [{ term, start }] : [];
    });
  const starts: { term: string; start: number }[] = [];
  for (const candidate of candidates) {
    const previous = starts.at(-1);
    // Two patterns can hit the same sentence; the earlier start wins.
    if (previous && candidate.start <= previous.start) continue;
    starts.push(candidate);
  }
  return starts.map((candidate, i) => ({
    ...candidate,
    end: definitionEnd(
      text,
      candidate.start,
      starts[i + 1]?.start ?? text.length,
    ),
  }));
}

// "As used in this section", "In this Act:", "For purposes of this chapter". The bare "in this"
// form is anchored to a sentence/label start so incidental "... in this section ..." mentions
// don't set the scope; the "as used in" / "for purposes of" forms are specific enough anywhere.
const SCOPE_PHRASE =
  /(?:(?:as\s+used\s+in|for\s+(?:the\s+)?purposes?\s+of)|(?:^|[.;:!?—–)]\s*|\n\s*)in)\s+this\s+([a-z]+)\b/gi;
const DOCUMENT_UNITS = new Set(['act', 'chapter', 'title', 'bill']);
const SECTION_UNITS = new Set(['section']);
const SUBDIVISION_UNITS = new Set([
  'subsection',
  'paragraph',
  'division',
  'clause',
]);

function lastScopeUnit(text: string): string | undefined {
  const matches = [...text.matchAll(SCOPE_PHRASE)];
  return matches.at(-1)?.[1]?.toLowerCase();
}

function scopeFor(
  index: SectionIndex,
  section: Section,
  segmentText: string,
  preamble: string,
): Pick<Definition, 'scope' | 'scopeSectionId'> {
  // Nearest statement wins: the definition itself, its section's lead-in, then ancestors.
  const candidates: { unit: string | undefined; owner: Section }[] = [
    { unit: lastScopeUnit(segmentText.slice(0, 200)), owner: section },
    { unit: lastScopeUnit(preamble), owner: section },
    ...ancestry(index, section.id)
      .slice(0, -1)
      .reverse()
      .map((owner) => ({
        unit: lastScopeUnit(sectionText(owner, { includeDeleted: false })),
        owner,
      })),
  ];
  for (const { unit, owner } of candidates) {
    if (unit === undefined) continue;
    if (DOCUMENT_UNITS.has(unit)) return { scope: 'document' };
    if (SECTION_UNITS.has(unit)) {
      const target = enclosingSection(index, owner.id) ?? owner;
      return { scope: 'section', scopeSectionId: target.id };
    }
    if (SUBDIVISION_UNITS.has(unit))
      return { scope: 'section', scopeSectionId: owner.id };
    return { scope: 'unknown' };
  }
  return { scope: 'unknown' };
}

/** Definitions in current (non-struck) text, in document order. */
export function extractDefinitions(
  sections: readonly Section[],
  index: SectionIndex = buildSectionIndex(sections),
): Definition[] {
  const definitions: Definition[] = [];
  const seen = new Set<string>();
  const visit = (list: readonly Section[]): void => {
    for (const section of list) {
      const text = sectionText(section, { includeDeleted: false });
      const segments = segmentDefinitions(text);
      const preamble = segments[0] ? text.slice(0, segments[0].start) : '';
      for (const segment of segments) {
        const definitionText = text.slice(segment.start, segment.end).trim();
        const key = `${section.id}\u0000${segment.term.toLowerCase()}`;
        if (!definitionText || seen.has(key)) continue;
        seen.add(key);
        definitions.push({
          term: segment.term,
          text: definitionText,
          sectionId: section.id,
          ...scopeFor(index, section, definitionText, preamble),
        });
      }
      visit(section.children);
    }
  };
  visit(sections);
  return definitions;
}

/** Union by (section, term), keeping what the parser already supplied first. */
export function mergeDefinitions(
  existing: readonly Definition[],
  found: readonly Definition[],
): Definition[] {
  const merged = [...existing];
  const keys = new Set(
    existing.map((d) => `${d.sectionId}\u0000${d.term.toLowerCase()}`),
  );
  for (const definition of found) {
    const key = `${definition.sectionId}\u0000${definition.term.toLowerCase()}`;
    if (!keys.has(key)) {
      keys.add(key);
      merged.push(definition);
    }
  }
  return merged;
}

export type TermMatcher = (
  text: string,
  sectionId: string,
  ownTerm?: string,
) => string[];

function appliesTo(definition: Definition, sectionId: string): boolean {
  if (definition.scope !== 'section' || definition.scopeSectionId === undefined)
    return true;
  return (
    sectionId === definition.scopeSectionId ||
    sectionId.startsWith(`${definition.scopeSectionId}/`)
  );
}

/**
 * Builds a matcher for "which defined terms appear in this text". Case-insensitive, whole
 * word, longest term first: text matched by a long term ("dependent child") is hidden from
 * shorter ones ("child") so only the most specific term is reported. Section-scoped terms
 * only match inside their section. `ownTerm` is never reported (a definition does not "use"
 * itself) but still hides its own occurrences.
 */
export function createTermMatcher(
  definitions: readonly Definition[],
): TermMatcher {
  const terms = new Map<string, Definition[]>();
  for (const definition of definitions) {
    const key = definition.term.toLowerCase();
    terms.set(key, [...(terms.get(key) ?? []), definition]);
  }
  // Longest first. Matching is done by hand rather than with one RegExp per term: a Unicode,
  // case-insensitive pattern costs milliseconds to compile, and a definitions section can
  // have hundreds of terms.
  const compiled = [...terms.entries()]
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b))
    .map(([key, defs]) => ({
      key,
      defs,
      name: defs[0]?.term ?? key,
      words: key.split(/\s+/).filter(Boolean),
      tokens: [...new Set(key.match(WORD) ?? [])],
    }));
  // A term can only match where all of its words occur, so check the words first.
  const byToken = new Map<string, number[]>();
  const unindexed: number[] = [];
  compiled.forEach((term, i) => {
    const first = term.tokens[0];
    if (first === undefined) unindexed.push(i);
    else byToken.set(first, [...(byToken.get(first) ?? []), i]);
  });
  return (text, sectionId, ownTerm) => {
    let masked = lowerKeepingLength(text);
    const found: { name: string; position: number }[] = [];
    const present = new Set(masked.match(WORD) ?? []);
    const wanted = new Set(unindexed);
    for (const token of present)
      for (const i of byToken.get(token) ?? [])
        if (compiled[i]?.tokens.every((t) => present.has(t))) wanted.add(i);
    for (const term of [...wanted]
      .sort((a, b) => a - b)
      .map((i) => compiled[i])) {
      if (!term?.defs.some((d) => appliesTo(d, sectionId))) continue;
      const spans = findPhrase(masked, term.words);
      for (const [start, end] of spans)
        masked =
          masked.slice(0, start) + ' '.repeat(end - start) + masked.slice(end);
      const first = spans[0]?.[0];
      if (first !== undefined && term.key !== ownTerm?.toLowerCase())
        found.push({ name: term.name, position: first });
    }
    return found.sort((a, b) => a.position - b.position).map((f) => f.name);
  };
}

const WORD = /[\p{L}\p{N}_]+/gu;
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SPACE_CHAR = /\s/;

/** Lower-cases without changing any offsets (a few characters lower-case to two). */
function lowerKeepingLength(text: string): string {
  let out = '';
  for (const ch of text) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Whole-word occurrences of `words` separated by any whitespace, left to right. */
function findPhrase(
  text: string,
  words: readonly string[],
): [number, number][] {
  const first = words[0];
  if (first === undefined) return [];
  const spans: [number, number][] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(first, from);
    if (at === -1) return spans;
    from = at + 1;
    if (at > 0 && WORD_CHAR.test(text.charAt(at - 1))) continue;
    let pos = at + first.length;
    let ok = true;
    for (const word of words.slice(1)) {
      let next = pos;
      while (next < text.length && SPACE_CHAR.test(text.charAt(next))) next++;
      if (next === pos || !text.startsWith(word, next)) {
        ok = false;
        break;
      }
      pos = next + word.length;
    }
    if (!ok || (pos < text.length && WORD_CHAR.test(text.charAt(pos))))
      continue;
    spans.push([at, pos]);
    from = pos;
  }
}
