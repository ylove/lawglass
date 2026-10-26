/**
 * Which parts of a bill get their own "Section by section" card (spec amendment 18).
 *
 * Start from the same units the summary maps over (`chooseMapUnits`), then:
 *   1. open any container (a division or title has no text of its own, so it cannot be briefed);
 *   2. drop boilerplate that says nothing about what the bill does to anyone: the preamble, the
 *      short title, table of contents, severability, an effective date and nothing else, a section that only
 *      defines terms, rules of construction. Definitions still reach the briefs as context;
 *   3. keep at most `MAX_BREAKDOWN_UNITS`, in document order, and report the rest as omitted.
 *
 * The rules are deliberately plain heading and opening-words checks. A missed skip costs one
 * dull card; a wrongly skipped part would hide a provision, so every pattern is anchored.
 */
import { chooseMapUnits, isContainer } from '../chip-summary.js';
import { sectionText, walkSections, type Section } from '../model/index.js';

/** A card per substantive part, up to this many. Longer bills report the rest as `omitted`. */
export const MAX_BREAKDOWN_UNITS = 30;

/** Whole-heading terms that carry no substance on their own. */
const BOILERPLATE_TERMS =
  /^(?:short titles?|titles?|table of contents|contents|severability|separability|effective dates?|effective date and applicability|when effective|rules? of construction|construction|definitions?|applicability)$/i;

/** "Short title; table of contents" is two boilerplate terms joined, so both must match. */
function headingIsBoilerplate(heading: string | undefined): boolean {
  // Separators become "|"; each piece is reduced to its words, so punctuation and spacing
  // ("Short title.", "Short  title") cannot hide a match.
  const parts = (heading ?? '')
    .replace(/[;,&]/g, '|')
    .replace(/\band\b/gi, '|')
    .split('|')
    .map((piece) => (piece.match(/[a-z]+/gi) ?? []).join(' '))
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => BOILERPLATE_TERMS.test(p));
}

/** Opening words that identify boilerplate in sections with no heading (Ohio-style bills). */
const BOILERPLATE_OPENING: readonly RegExp[] = [
  /^(?:this|these)\s+(?:act|title|division|chapter|bill|subtitle)\s+may\s+be\s+cited\s+as\b/i,
  /^table of contents\b/i,
  /^if\s+any\s+(?:provision|part|section)\b[^.]{0,200}\bheld\s+(?:to\s+be\s+)?(?:invalid|unconstitutional)/i,
  /^(?:in|for\s+(?:the\s+)?purposes?\s+of)\s+this\s+\w+,?\s+(?:the\s+following\s+(?:terms|definitions)|the\s+term)\b/i,
  /^as\s+used\s+in\s+this\s+\w+,?\s+(?:the\s+following|the\s+term|unless)/i,
];

/** A short section that only says when the bill starts. Longer text may carry more. */
const EFFECTIVE_ONLY_MAX_CHARS = 200;
const EFFECTIVE_ONLY =
  /^(?:this|the)\s+[^.]{0,80}\b(?:takes?|shall\s+take|goes?|shall\s+go)\s+(?:into\s+)?effect\b/i;

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

/** True for parts that set up the bill rather than do something. */
export function isBoilerplate(section: Section): boolean {
  if (PREAMBLE_ID.test(section.id)) return true;
  if (headingIsBoilerplate(section.heading)) return true;
  const text = subtreeText(section);
  if (BOILERPLATE_OPENING.some((p) => p.test(text))) return true;
  return text.length <= EFFECTIVE_ONLY_MAX_CHARS && EFFECTIVE_ONLY.test(text);
}

/** Open containers recursively; a container with no text of its own cannot be a unit. */
function leaves(sections: readonly Section[]): Section[] {
  return sections.flatMap((s) => (isContainer(s) ? leaves(s.children) : [s]));
}

export function chooseBreakdownUnits(sections: readonly Section[]): {
  units: Section[];
  /** Substantive parts beyond the cap, plus any the summary's unit choice already left out. */
  omitted: number;
} {
  const mapUnits = chooseMapUnits(sections);
  const substantive = leaves(mapUnits.units).filter(
    (s) => subtreeText(s) !== '' && !isBoilerplate(s),
  );
  return {
    units: substantive.slice(0, MAX_BREAKDOWN_UNITS),
    omitted:
      Math.max(0, substantive.length - MAX_BREAKDOWN_UNITS) + mapUnits.omitted,
  };
}
