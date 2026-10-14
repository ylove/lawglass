import {
  sectionText,
  walkSections,
  type AmendsTarget,
  type BillMetadata,
  type Section,
} from '../model/index.js';
import { charterName, findExternalMatches } from './refs.js';
import { normalizeSectionNum } from './section-index.js';

/** How far around a charter mention an "amend" verb still counts as the measure amending it. */
const BEFORE_CHARS = 250;
const AFTER_CHARS = 80;

function hasMarks(section: Section): boolean {
  return (
    section.spans.some((s) => s.status !== 'unchanged') ||
    section.children.some(hasMarks)
  );
}

/** Whether any descendant carries its own section number (so `section` is not a leaf). */
function hasNumberedDescendant(section: Section): boolean {
  return section.children.some(
    (c) =>
      (c.num !== undefined && normalizeSectionNum(c.num) !== undefined) ||
      hasNumberedDescendant(c),
  );
}

/**
 * Charter sections the document restates with amendment markup: the numbered sections that
 * show struck or underlined text. Only the innermost numbered section counts, so a bill's own
 * "Section 1" that merely contains them is not mistaken for charter text.
 */
function restatedSections(sections: readonly Section[]): string[] {
  const nums: string[] = [];
  for (const section of walkSections(sections)) {
    const num =
      section.num === undefined ? undefined : normalizeSectionNum(section.num);
    if (
      num !== undefined &&
      hasMarks(section) &&
      !hasNumberedDescendant(section)
    )
      nums.push(num);
  }
  return nums;
}

/**
 * What the measure amends, when it says so about a city charter: "To amend the City Charter",
 * "amend Sections 3 and 46-3 of the Charter of the City of Columbus", "the following sections
 * of the Charter". A charter that is only mentioned ("pursuant to the City Charter") does not
 * count: an amend verb has to sit next to the mention. Deterministic, no model call.
 *
 * `sections` is the union of numbers the text lists explicitly and numbers the document
 * restates with markup. A listed number with no matching heading is kept: the measure named
 * it, even if it did not reprint it.
 */
export function detectAmends(
  sections: readonly Section[],
  metadata: Pick<BillMetadata, 'title' | 'jurisdiction'>,
): AmendsTarget | undefined {
  const text = [
    metadata.title ?? '',
    ...sections.map((s) => sectionText(s, { includeDeleted: false })),
  ].join('\n');
  const charter = findExternalMatches(text).filter(
    (m) => m.category === 'charter',
  );
  const amending = charter.filter(
    (m) =>
      /\bamend/i.test(
        text.slice(Math.max(0, m.start - BEFORE_CHARS), m.start),
      ) || /\bamend/i.test(text.slice(m.end, m.end + AFTER_CHARS)),
  );
  if (amending.length === 0) return undefined;

  const city = charter.find((m) => m.city !== undefined)?.city;
  const listed = amending.flatMap((m) =>
    m.sectionNum === undefined ? [] : [m.sectionNum],
  );
  return {
    name: charterName(city),
    ...(metadata.jurisdiction ? { jurisdiction: metadata.jurisdiction } : {}),
    sections: [...new Set([...listed, ...restatedSections(sections)])],
  };
}
