/**
 * Section excerpts for the citation drawer and the CLI. Built from the cached NormalizedDoc
 * (never from the index), so the text is the full source text including struck spans.
 */
import { breadcrumb, levelNum } from '../chunk/index.js';
import { referenceHeading } from '../answer/references.js';
import {
  AppError,
  REFERENCE_ID_PREFIX,
  type NormalizedDoc,
  type Section,
  type SectionExcerpt,
  type SourceLocation,
  type Span,
} from '../model/index.js';

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

/** Human-readable path such as "Division A > Title I > Sec. 101 Grants" (the chunker's form). */
export function breadcrumbFor(path: readonly Section[]): string {
  return breadcrumb(path);
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
 * The label the chunker puts in front of a merged child ("(a) Heading."), or '' when the
 * child's own text already starts with it. PDF/HTML/text parsers use the first body line as the
 * heading, so repeating the label would show the same words twice.
 */
function childLabel(child: Section): string {
  const text = child.spans
    .map((s) => s.text)
    .join('')
    .trimStart();
  const label = [child.num, child.heading].filter(Boolean).join(' ');
  if (!label) return '';
  if (
    (child.num && text.startsWith(child.num)) ||
    (!child.num && child.heading && text.startsWith(child.heading))
  )
    return '';
  const punctuation = child.heading && !/[.!?:]$/.test(label) ? '.' : '';
  return `${label}${punctuation} `;
}

/**
 * The section's own spans plus its LEAF children's spans, each child introduced by its label.
 * This is exactly what a chunk carrying this section id can contain: the chunker merges only
 * small leaf siblings into their parent's chunk, and every deeper section is cited by its own
 * id. Showing the whole subtree would disagree with the chunk the model actually saw.
 */
export function sectionExcerpt(
  doc: Pick<NormalizedDoc, 'sections'> &
    Partial<Pick<NormalizedDoc, 'references'>>,
  sectionId: string,
): SectionExcerpt {
  // Another law's text read for this document (issue #275). It has no page or lines here, and
  // its spans are never struck or inserted: it is the current official text, as fetched.
  if (sectionId.startsWith(REFERENCE_ID_PREFIX)) {
    const reference = doc.references?.find((r) => r.sectionId === sectionId);
    if (!reference)
      throw new AppError('INVALID_INPUT', `Unknown section "${sectionId}".`, {
        userMessage: 'That section is not in this document.',
      });
    return {
      sectionId: reference.sectionId,
      breadcrumb: referenceHeading(reference),
      ...(reference.heading === undefined
        ? {}
        : { heading: reference.heading }),
      spans: [{ text: reference.text, status: 'unchanged' }],
      location: {},
      reference: { citation: reference.citation, url: reference.sourceUrl },
    };
  }
  const path = findSectionPath(doc.sections, sectionId);
  const section = path?.at(-1);
  if (!path || !section)
    throw new AppError('INVALID_INPUT', `Unknown section "${sectionId}".`, {
      userMessage: 'That section is not in this document.',
    });

  const spans: Span[] = [...section.spans];
  for (const child of section.children) {
    if (child.children.length > 0) continue;
    const label = childLabel(child);
    if (label || spans.length > 0)
      spans.push({
        text: `${spans.length > 0 ? '\n\n' : ''}${label}`,
        status: 'unchanged',
      });
    spans.push(...child.spans);
  }

  return {
    sectionId: section.id,
    breadcrumb: breadcrumbFor(path),
    ...(section.num === undefined ? {} : { num: section.num }),
    ...(section.heading === undefined ? {} : { heading: section.heading }),
    spans,
    location: locationOf(spans, section),
  };
}

/** The printed label of a node alone: "Sec. 4", "Division A", "(b)". */
export function numLabel(section: Section): string {
  return levelNum(section);
}
