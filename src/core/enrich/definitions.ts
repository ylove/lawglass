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

const VERBS =
  '(?:means?|includes?|shall\\s+mean|has\\s+the\\s+meaning|have\\s+the\\s+meaning|refers?\\s+to)';
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

/**
 * Where the definition containing a match begins, or undefined when the match sits in the
 * middle of a sentence ("... the word "x" means ..." in operative text is not a definition).
 */
function segmentStart(text: string, matchIndex: number): number | undefined {
  let rest = text.slice(0, matchIndex);
  rest = rest.replace(LEAD_IN, '');
  const label = LABEL.exec(rest);
  if (label && label[0].length > 0) rest = rest.slice(0, label.index);
  return SENTENCE_BREAK.test(rest) ? rest.trimEnd().length : undefined;
}

export function normalizeTerm(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ');
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
  const segments: DefinitionSegment[] = [];
  for (const candidate of candidates) {
    const previous = segments.at(-1);
    // Two patterns can hit the same sentence; the earlier start wins.
    if (previous && candidate.start <= previous.start) continue;
    if (previous) previous.end = candidate.start;
    segments.push({ ...candidate, end: text.length });
  }
  return segments;
}

// "As used in this section", "In this Act:", "For purposes of this chapter". Anchored to a
// sentence/label start so incidental "... in this section ..." mentions don't set the scope.
const SCOPE_PHRASE =
  /(?:^|[.;:!?—–)]\s*|\n\s*)(?:as\s+used\s+in|for\s+(?:the\s+)?purposes?\s+of|in)\s+this\s+([a-z]+)\b/gi;
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

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
  const compiled = [...terms.entries()]
    .sort(([a], [b]) => b.length - a.length || a.localeCompare(b))
    .map(([key, defs]) => ({
      key,
      defs,
      name: defs[0]?.term ?? key,
      pattern: new RegExp(
        `(?<![\\p{L}\\p{N}_])${key
          .split(/\s+/)
          .map(escapeRegExp)
          .join('\\s+')}(?![\\p{L}\\p{N}_])`,
        'giu',
      ),
    }));
  return (text, sectionId, ownTerm) => {
    let masked = text;
    const found: { name: string; position: number }[] = [];
    for (const term of compiled) {
      if (!term.defs.some((d) => appliesTo(d, sectionId))) continue;
      term.pattern.lastIndex = 0;
      let first: number | undefined;
      for (const match of masked.matchAll(term.pattern)) {
        first ??= match.index;
        masked =
          masked.slice(0, match.index) +
          ' '.repeat(match[0].length) +
          masked.slice(match.index + match[0].length);
      }
      if (first !== undefined && term.key !== ownTerm?.toLowerCase())
        found.push({ name: term.name, position: first });
    }
    return found.sort((a, b) => a.position - b.position).map((f) => f.name);
  };
}
