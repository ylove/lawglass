/** Turns validated citations into the CLI's `Sec. X, p. Y, lines A–B` form. */
import type {
  Citation,
  NormalizedDoc,
  Section,
  SourceLocation,
} from '../model/index.js';
import { findSectionPath, numLabel } from './excerpt.js';

function range(label: string, labels: string, a?: number, b?: number): string {
  if (a === undefined) return '';
  return b === undefined || b === a
    ? `${label} ${String(a)}`
    : `${labels} ${String(a)}–${String(b)}`;
}

/** "p. 3, lines 12–18". Empty for XML/HTML, which have no pages or printed lines. */
export function formatLocation(location: SourceLocation | undefined): string {
  if (!location) return '';
  return [
    range('p.', 'pp.', location.pageStart, location.pageEnd),
    range('line', 'lines', location.lineStart, location.lineEnd),
  ]
    .filter(Boolean)
    .join(', ');
}

/** "Sec. 4(b)(2)": the top-level number, then enumerators attached; other levels after " > ". */
function pathLabel(path: readonly Section[]): string {
  const [first, ...rest] = path;
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
 * printed number, not the internal id; unknown ids fall back to the id itself.
 */
export function formatCitation(
  citation: Citation,
  doc: Pick<NormalizedDoc, 'sections'>,
): string {
  const path = findSectionPath(doc.sections, citation.sectionId);
  const name = path ? pathLabel(path) : citation.sectionId;
  return [name, formatLocation(citation.location)].filter(Boolean).join(', ');
}
