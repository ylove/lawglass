/**
 * Which parts of a bill get their own "Section by section" card (spec amendment 22).
 *
 * Start from the same units the summary maps over (`chooseMapUnits`), then:
 *   1. open any container (a division or title has no text of its own, so it cannot be briefed);
 *   2. drop boilerplate that says nothing about what the bill does to anyone: the preamble, the
 *      short title, table of contents, severability, rules of construction, a short part that only
 *      states a date, and a part that is only definitions. Definitions still reach the briefs as
 *      context;
 *   3. keep at most `MAX_BREAKDOWN_UNITS`, in document order, and report the rest as omitted.
 *
 * A missed skip costs one dull card; a wrongly skipped part hides a provision. So headings are
 * matched whole, opening-words rules apply only to parts with no heading, a date or definitions
 * part is skipped only when the whole of it is a date or definitions, and every skip that rests
 * on the text (not on a heading like "Short title") is counted in `omitted`.
 */
import { chooseMapUnits, isContainer } from '../chip-summary.js';
import { sectionText, walkSections, type Section } from '../model/index.js';

/** A card per substantive part, up to this many. Longer bills report the rest as `omitted`. */
export const MAX_BREAKDOWN_UNITS = 30;

/**
 * Changing any rule below changes which parts get a brief, so it must invalidate cached
 * breakdowns. Folded into `BREAKDOWN_PROMPT_VERSION`.
 */
export const UNIT_RULES_VERSION = 2;

/** Headings that are boilerplate whatever the text under them says. */
const BOILERPLATE_TERMS =
  /^(?:short titles?|titles?|table of contents|contents|severability|separability|rules? of construction|construction|definitions?)$/i;

/**
 * Headings that are boilerplate only when the part is short and just states a date or scope. A
 * section called "Effective date" can carry real rules, so length decides.
 */
const DATE_TERMS =
  /^(?:effective dates?|effective date and applicability|when effective|applicability|applicability and effective date)$/i;

/** A short section that only says when the bill starts. Longer text may carry more. */
const DATE_ONLY_MAX_CHARS = 200;

/** Words of a heading, with separators (";", ",", "&", "and") splitting it into pieces. */
function headingPieces(heading: string | undefined): string[] {
  // Separators become "|"; each piece is reduced to its words, so punctuation and spacing
  // ("Short title.", "Short  title") cannot hide a match.
  return (heading ?? '')
    .replace(/[;,&]/g, '|')
    .replace(/\band\b/gi, '|')
    .split('|')
    .map((piece) => (piece.match(/[a-z]+/gi) ?? []).join(' '))
    .filter(Boolean);
}

/** "Short title; table of contents" is two boilerplate terms joined, so every piece must match. */
function headingIsBoilerplate(heading: string | undefined): boolean {
  const parts = headingPieces(heading);
  return parts.length > 0 && parts.every((p) => BOILERPLATE_TERMS.test(p));
}

function headingIsDateTerm(heading: string | undefined): boolean {
  const parts = headingPieces(heading);
  return (
    parts.length > 0 &&
    parts.every((p) => BOILERPLATE_TERMS.test(p) || DATE_TERMS.test(p))
  );
}

/**
 * Opening words that identify boilerplate in sections with NO heading (Ohio-style bills). They
 * are never applied to a section that has a heading: "In this section, the term ..." opens many
 * substantive federal sections.
 */
const BOILERPLATE_OPENING: readonly RegExp[] = [
  /^(?:this|these)\s+(?:act|title|division|chapter|bill|subtitle)\s+may\s+be\s+cited\s+as\b/i,
  /^table of contents\b/i,
  /^if\s+any\s+(?:provision|part|section)\b[^.]{0,200}\bheld\s+(?:to\s+be\s+)?(?:invalid|unconstitutional)/i,
  /^(?:in|for\s+(?:the\s+)?purposes?\s+of)\s+this\s+\w+,?\s+(?:the\s+following\s+(?:terms|definitions)|the\s+term)\b/i,
  /^as\s+used\s+in\s+this\s+\w+,?\s+(?:the\s+following|the\s+term|unless)/i,
];

const EFFECTIVE_ONLY =
  /^(?:this|the)\s+[^.]{0,80}\b(?:takes?|shall\s+take|goes?|shall\s+go)\s+(?:into\s+)?effect\b/i;

/** A subsection that defines a term: optional "(1)", then a quoted term, then "means"/"includes". */
const DEFINES_A_TERM =
  /^\s*(?:\(\w+\)\s*)?["“'‘][^"”]{1,80}["”'’]?[^.]{0,60}\b(?:means|includes|has the meaning)\b/i;

/** The section's own text with every descendant's, so a heading-only parent still counts. */
export function subtreeText(section: Section): string {
  return [...walkSections([section])]
    .map((s) => sectionText(s, { includeDeleted: true }))
    .join('\n')
    .trim();
}

/**
 * Text before the first section (the bill's title line, "A BILL to...", the enacting clause) is
 * kept by the parsers as a section called `preamble`. It introduces the bill; it does nothing.
 */
const PREAMBLE_ID = /^preamble(?:-\d+)?$/;

/** Why a part was skipped. `content` skips rest on the text, so they are reported as omitted. */
export type SkipReason = 'heading' | 'content';

/** True when the part is nothing but definitions: every subsection defines a term. */
function onlyDefinitions(section: Section): boolean {
  if (section.children.length === 0) return false;
  return section.children.every((child) => {
    const own = sectionText(child, { includeDeleted: true }).trim();
    return own !== '' ? DEFINES_A_TERM.test(own) : onlyDefinitions(child);
  });
}

/** Why this part is boilerplate, or undefined when it is substantive. */
export function skipReason(section: Section): SkipReason | undefined {
  if (PREAMBLE_ID.test(section.id) || headingIsBoilerplate(section.heading))
    return 'heading';
  const text = subtreeText(section);
  if (headingIsDateTerm(section.heading) && text.length <= DATE_ONLY_MAX_CHARS)
    return 'heading';
  if (!section.heading?.trim()) {
    if (BOILERPLATE_OPENING.some((p) => p.test(text))) return 'content';
    if (text.length <= DATE_ONLY_MAX_CHARS && EFFECTIVE_ONLY.test(text))
      return 'content';
    return undefined;
  }
  // A headed part is a definitions part only if all of it defines terms.
  return onlyDefinitions(section) ? 'content' : undefined;
}

/** True for parts that set up the bill rather than do something. */
export function isBoilerplate(section: Section): boolean {
  return skipReason(section) !== undefined;
}

/** Open containers recursively; a container with no text of its own cannot be a unit. */
function leaves(sections: readonly Section[]): Section[] {
  return sections.flatMap((s) => (isContainer(s) ? leaves(s.children) : [s]));
}

export function chooseBreakdownUnits(sections: readonly Section[]): {
  units: Section[];
  /**
   * Parts the reader is not shown: substantive parts beyond the cap, parts the summary's unit
   * choice left out, and parts skipped because of what their text says (not because of a
   * boilerplate heading like "Short title"), so a wrong skip is never silent.
   */
  omitted: number;
} {
  const mapUnits = chooseMapUnits(sections);
  let contentSkips = 0;
  const substantive = leaves(mapUnits.units).filter((s) => {
    if (subtreeText(s) === '') return false;
    const reason = skipReason(s);
    if (reason === 'content') contentSkips++;
    return reason === undefined;
  });
  return {
    units: substantive.slice(0, MAX_BREAKDOWN_UNITS),
    omitted:
      Math.max(0, substantive.length - MAX_BREAKDOWN_UNITS) +
      mapUnits.omitted +
      contentSkips,
  };
}
