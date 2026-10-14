/**
 * Section excerpts for the citation drawer and the CLI. Built from the cached NormalizedDoc
 * (never from the index), so the text is the full source text including struck spans.
 */
import {
  AppError,
  type NormalizedDoc,
  type Section,
  type SectionExcerpt,
  type SourceLocation,
  type Span,
} from '../model/index.js';

/** Printed label for sections whose id says they are numbered sections ("sec-4" -> "Sec. 4"). */
export function numLabel(section: Section): string {
  const num = section.num ?? '';
  const prefix = /^([a-z]+)-/.exec(section.id.split('/').at(-1) ?? '')?.[1];
  const labelled = /^(?:sec(?:tion)?\.?(?:\s|$)|§|\()/i.test(num);
  return num && prefix === 'sec' && !labelled ? `Sec. ${num}` : num;
}

function label(section: Section): string {
  return [numLabel(section), section.heading].filter(Boolean).join(' ');
}

/** Path from a top-level section to `id`, or undefined when the id is not in the tree. */
export function findSectionPath(
  sections: readonly Section[],
  id: string,
): Section[] | undefined {
  for (const section of sections) {
    if (section.id === id) return [section];
    const below = findSectionPath(section.children, id);
    if (below) return [section, ...below];
  }
  return undefined;
}

/** Human-readable path such as "Sec. 4 Grants > (b) Eligibility". */
export function breadcrumbFor(path: readonly Section[]): string {
  return path.map((s) => label(s) || s.id).join(' > ');
}

/** Same rule as the chunker: first line from the first page, last line from the last page. */
function locationOf(
  spans: readonly Span[],
  own: SourceLocation,
): SourceLocation {
  const pages = spans.flatMap((s) => (s.page === undefined ? [] : [s.page]));
  if (pages.length === 0) {
    const { pageStart, pageEnd, lineStart, lineEnd } = own;
    return {
      ...(pageStart === undefined ? {} : { pageStart }),
      ...(pageEnd === undefined ? {} : { pageEnd }),
      ...(lineStart === undefined ? {} : { lineStart }),
      ...(lineEnd === undefined ? {} : { lineEnd }),
    };
  }
  const pageStart = Math.min(...pages);
  const pageEnd = Math.max(...pages);
  const lines = (page: number): number[] =>
    spans.flatMap((s) =>
      s.page === page && s.line !== undefined ? [s.line] : [],
    );
  const first = lines(pageStart);
  const last = lines(pageEnd);
  return {
    pageStart,
    pageEnd,
    ...(first.length ? { lineStart: Math.min(...first) } : {}),
    ...(last.length ? { lineEnd: Math.max(...last) } : {}),
  };
}

/**
 * The section's own spans followed by every descendant's spans in document order, each
 * descendant introduced by its number and heading. A chunk covering a merged parent cites the
 * parent, so the excerpt has to show the children's text too.
 */
export function sectionExcerpt(
  doc: Pick<NormalizedDoc, 'sections'>,
  sectionId: string,
): SectionExcerpt {
  const path = findSectionPath(doc.sections, sectionId);
  const section = path?.at(-1);
  if (!path || !section)
    throw new AppError('INVALID_INPUT', `Unknown section "${sectionId}".`, {
      userMessage: 'That section is not in this document.',
    });

  const spans: Span[] = [...section.spans];
  const addChildren = (parent: Section): void => {
    for (const child of parent.children) {
      const heading = label(child);
      if (heading) {
        const separator = spans.length > 0 ? '\n\n' : '';
        spans.push({ text: `${separator}${heading}. `, status: 'unchanged' });
      }
      spans.push(...child.spans);
      addChildren(child);
    }
  };
  addChildren(section);

  return {
    sectionId: section.id,
    breadcrumb: breadcrumbFor(path),
    ...(section.num === undefined ? {} : { num: section.num }),
    ...(section.heading === undefined ? {} : { heading: section.heading }),
    spans,
    location: locationOf(spans, section),
  };
}
