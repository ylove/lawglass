/** Turns validated citations into the CLI's `Sec. X, p. Y, lines A–B` form. */
import type {
  Citation,
  NormalizedDoc,
  Section,
  SourceLocation,
} from '../model/index.js';
import { findSectionPath, numLabel, sectionExcerpt } from './excerpt.js';

/**
 * "p. 3, lines 12–18"; across a page break "p. 3, line 20 – p. 4, line 5". Empty for XML/HTML,
 * which have no pages or printed lines.
 */
export function formatLocation(location: SourceLocation | undefined): string {
  if (location?.pageStart === undefined) {
    return location?.lineStart === undefined
      ? ''
      : lineRange(location.lineStart, location.lineEnd);
  }
  const { pageStart, pageEnd = pageStart, lineStart, lineEnd } = location;
  if (pageEnd !== pageStart) {
    const from = `p. ${String(pageStart)}${lineStart === undefined ? '' : `, line ${String(lineStart)}`}`;
    const to = `p. ${String(pageEnd)}${lineEnd === undefined ? '' : `, line ${String(lineEnd)}`}`;
    return lineStart === undefined && lineEnd === undefined
      ? `pp. ${String(pageStart)}–${String(pageEnd)}`
      : `${from} – ${to}`;
  }
  const lines = lineStart === undefined ? '' : lineRange(lineStart, lineEnd);
  return [`p. ${String(pageStart)}`, lines].filter(Boolean).join(', ');
}

function lineRange(start: number, end: number | undefined): string {
  return end === undefined || end === start
    ? `line ${String(start)}`
    : `lines ${String(start)}–${String(end)}`;
}

/**
 * "Sec. 4(b)(2)": the nearest numbered section (id prefix `sec-`) with the enumerators below it
 * attached. Divisions and titles above a section are left out ("Sec. 4101", not
 * "D > XLI > Sec. 4101"); a cited node with no section above it prints its own label
 * ("Division A").
 */
function pathLabel(path: readonly Section[]): string {
  let start = path.length - 1;
  for (let i = path.length - 1; i >= 0; i--) {
    if ((path[i]?.id.split('/').at(-1) ?? '').startsWith('sec-')) {
      start = i;
      break;
    }
  }
  const [first, ...rest] = path.slice(start);
  if (!first) return '';
  let text = numLabel(first) || first.id;
  for (const section of rest) {
    const num = section.num;
    if (!num) continue;
    text += num.startsWith('(') ? num : ` > ${numLabel(section)}`;
  }
  return text;
}

/**
 * One citation as a line of text. Sections are looked up in the cached doc so the label is the
 * printed number, not the internal id, and the location comes from the same excerpt the
 * citation drawer shows, so the CLI and the UI always agree. Unknown ids fall back to the
 * id and the citation's own location.
 */
export function formatCitation(
  citation: Citation,
  doc: Pick<NormalizedDoc, 'sections'>,
): string {
  const path = findSectionPath(doc.sections, citation.sectionId);
  if (!path) {
    return [citation.sectionId, formatLocation(citation.location)]
      .filter(Boolean)
      .join(', ');
  }
  const { location } = sectionExcerpt(doc, citation.sectionId);
  return [pathLabel(path), formatLocation(location)].filter(Boolean).join(', ');
}
