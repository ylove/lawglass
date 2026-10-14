/**
 * PDF parser: PDF.js text and drawing operators -> NormalizedDoc. The pipeline per page is
 * extract (here), lay out and mark amendments (pdf-lines.ts, pdf-geometry.ts), then detect
 * sections over the whole document (sections.ts). Design: docs/decisions/0006.
 */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';
import {
  AnnotationMode,
  getDocument,
  PDFWorker,
  PasswordException,
  VerbosityLevel,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import { AppError, EMPTY_METADATA, NormalizedDoc } from '../model/index.js';
import {
  collectGlyphWidths,
  extractMarkSegments,
  type PdfTextItem,
} from './pdf-geometry.js';
import { layoutPages, type PageContent, type StyledLine } from './pdf-lines.js';
import {
  detectSections,
  startsWithHeading,
  type SectionDetectionOptions,
  type SourceLine,
} from './sections.js';

export interface PdfParseOptions extends SectionDetectionOptions {
  sourceUrl: string;
  /** Supplied by the fetch step so parsing is deterministic. */
  fetchedAt: string;
}

const context = z.object({ sourceUrl: z.url(), fetchedAt: z.iso.datetime() });

/** A page with fewer visible characters than this has no usable text layer. */
const MIN_PAGE_CHARACTERS = 10;

// PDF.js reads its standard-font metrics from disk in Node; the path must end with a separator.
const STANDARD_FONTS =
  join(
    dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json')),
    'standard_fonts',
  ) + sep;

// PDF.js types text-item transforms as any[]; validate them at this boundary.
const textItem = z.object({
  str: z.string(),
  width: z.number(),
  fontName: z.string(),
  transform: z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
});

interface ExtractedPage extends PageContent {
  /** Rotated or vertical text was skipped. */
  skippedRotated: boolean;
}

async function extractPage(
  page: PDFPageProxy,
  pageNumber: number,
): Promise<ExtractedPage> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let skippedRotated = false;
  for (const raw of content.items) {
    const parsed = textItem.safeParse(raw);
    // Marked-content entries have no text; whitespace-only items (PDF.js emits them for gaps,
    // including one beside every printed line number) carry nothing a gap cannot.
    if (!parsed.success || !/\S/.test(parsed.data.str)) continue;
    const [a, b, c, d, x, y] = parsed.data.transform;
    // Amendment geometry assumes horizontal text; margin stamps and watermarks are not body text.
    if (Math.abs(b) > 1e-3 * Math.abs(a) || Math.abs(c) > 1e-3 * Math.abs(d)) {
      skippedRotated = true;
      continue;
    }
    items.push({
      text: parsed.data.str,
      x,
      y,
      width: parsed.data.width,
      fontSize: Math.abs(d),
      fontName: parsed.data.fontName,
    });
  }
  // Annotations are reader markup (a reviewer's strikeout), never the bill's own amendments.
  const operators = await page.getOperatorList({
    annotationMode: AnnotationMode.DISABLE,
  });
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  return {
    page: pageNumber,
    view: [x0, y0, x1, y1],
    items,
    segments: extractMarkSegments(operators.fnArray, operators.argsArray),
    widths: collectGlyphWidths(operators.fnArray, operators.argsArray),
    skippedRotated,
  };
}

async function extractPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  // A worker per call keeps parses independent; in Node it runs on this thread.
  const worker = new PDFWorker();
  const task = getDocument({
    // PDF.js may detach the buffer it is given, and rejects Node Buffers; a plain copy avoids
    // both (Buffer#slice would share the caller's memory).
    data: new Uint8Array(bytes),
    worker,
    standardFontDataUrl: STANDARD_FONTS,
    verbosity: VerbosityLevel.ERRORS,
  });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (cause) {
      throw new AppError(
        'PARSE_FAILED',
        cause instanceof PasswordException
          ? 'The PDF is password-protected.'
          : 'The PDF could not be opened.',
        { cause },
      );
    }
    const pages: ExtractedPage[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      pages.push(await extractPage(page, number));
      // Keep only the extracted geometry; long bills run to thousands of pages.
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
    worker.destroy();
  }
}

const visibleCharacters = (page: PageContent): number =>
  page.items.reduce(
    (total, item) => total + item.text.replace(/\s/g, '').length,
    0,
  );

/**
 * Parse a PDF with a text layer. Struck text becomes `deleted` spans and underlined text
 * `inserted` spans; printed line numbers become span and section coordinates. Metadata is
 * left empty for the enrichment step. Throws `SCANNED_PDF` when no page has a text layer.
 */
export async function parsePdf(
  bytes: Uint8Array,
  options: PdfParseOptions,
): Promise<NormalizedDoc> {
  if (!context.safeParse(options).success) {
    throw new AppError(
      'INVALID_INPUT',
      'Invalid PDF document source or fetch timestamp.',
    );
  }
  // Hash the original bytes, before PDF.js sees (and may detach) a copy.
  const docId = createHash('sha256').update(bytes).digest('hex');
  const pages = await extractPages(bytes);
  const textless = pages.filter(
    (page) => visibleCharacters(page) < MIN_PAGE_CHARACTERS,
  );
  if (textless.length === pages.length) {
    throw new AppError('SCANNED_PDF', 'No page of the PDF has a text layer.');
  }
  const warnings = textless.map(
    ({ page }) =>
      `Page ${String(page)} has no text layer (it may be a scanned image), so its content is missing.`,
  );
  for (const { page, skippedRotated } of pages) {
    if (skippedRotated)
      warnings.push(
        `Page ${String(page)}: rotated text (such as a stamp) was skipped.`,
      );
  }
  const layout = layoutPages(pages);
  warnings.push(...layout.warnings);
  const doc = {
    docId,
    sourceUrl: options.sourceUrl,
    fetchedAt: options.fetchedAt,
    format: 'pdf',
    metadata: { ...EMPTY_METADATA },
    sections: detectSections(
      toSourceLines(layout.lines, options.patterns),
      options,
    ),
    definitions: [],
    externalRefs: [],
    warnings,
    pageCount: pages.length,
  };
  return NormalizedDoc.parse(doc);
}

/** Indents within this many points are the same indent. */
const INDENT_TOLERANCE = 2;
/** Share of lines that must start at an x for it to be the left margin. */
const MARGIN_SHARE = 0.1;
/** Share of heading-like lines that must be indented to call the layout first-line-indent. */
const INDENTED_HEADINGS = 0.75;

/**
 * Turn laid-out lines into section-detection input, using indentation two ways:
 *
 * 1. In a first-line-indent layout (Ohio, and GPO's federal bills), nearly every paragraph
 *    that opens with a marker is indented, and wrapped lines return to the left margin. A
 *    margin line that starts "(F) of that section" is then a wrapped cross-reference, so it
 *    is flagged as a continuation and never opens a section.
 * 2. Indentation only signals depth when paragraphs at different levels start at different
 *    indents. Ohio indents every level by the same amount, which would mislead the (i) letter
 *    versus (i) numeral heuristics, so x is passed only when heading indents differ.
 */
export function toSourceLines(
  lines: readonly StyledLine[],
  patterns?: SectionDetectionOptions['patterns'],
): SourceLine[] {
  // The left margin is the leftmost x that a fair share of lines start at; a stray title line
  // further left does not count, and short paragraphs cannot outvote it with their indent.
  const starts = new Map<number, number>();
  for (const line of lines) {
    const x = Math.round(line.x);
    starts.set(x, (starts.get(x) ?? 0) + 1);
  }
  const startsNear = (x: number): number =>
    [...starts]
      .filter(([other]) => Math.abs(other - x) <= INDENT_TOLERANCE)
      .reduce((total, [, count]) => total + count, 0);
  const margin = [...starts.keys()]
    .filter((x) => startsNear(x) >= MARGIN_SHARE * lines.length)
    .reduce<number | undefined>((left, x) => Math.min(left ?? x, x), undefined);
  const atMargin = (line: StyledLine): boolean =>
    margin !== undefined && Math.abs(line.x - margin) <= INDENT_TOLERANCE;
  const headings = lines.filter((line) =>
    startsWithHeading(line.text, patterns),
  );
  const indented = headings.filter((line) => !atMargin(line));
  const firstLineIndent =
    headings.length > 0 &&
    indented.length >= INDENTED_HEADINGS * headings.length;
  const openingIndents = (firstLineIndent ? indented : headings).map(
    (line) => line.x,
  );
  const useIndent =
    openingIndents.length > 0 &&
    openingIndents.reduce((a, b) => Math.max(a, b)) -
      openingIndents.reduce((a, b) => Math.min(a, b)) >
      INDENT_TOLERANCE;
  return lines.map((line) => ({
    text: line.text,
    page: line.page,
    ...(line.line === undefined ? {} : { line: line.line }),
    ...(useIndent ? { x: line.x } : {}),
    statuses: line.statuses,
    ...(firstLineIndent && atMargin(line) ? { continuation: true } : {}),
  }));
}
