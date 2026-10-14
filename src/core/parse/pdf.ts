/**
 * PDF parser: PDF.js text and drawing operators -> NormalizedDoc. The pipeline per page is
 * extract (here), lay out and mark amendments (pdf-lines.ts, pdf-geometry.ts), then detect
 * sections over the whole document (sections.ts). Design: docs/decisions/0006.
 */
import { createHash } from 'node:crypto';
import type { PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import { AppError, EMPTY_METADATA, NormalizedDoc } from '../model/index.js';
import {
  collectGlyphWidths,
  extractMarkSegments,
  withoutLinkUnderlines,
  type PdfTextItem,
  type Rect,
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

/**
 * A document is scanned when it paints images and no page has more than a stray stamp of text
 * (a page number, "HB 5"): fewer than this many visible characters on every page.
 */
const SCANNED_MAX_PAGE_CHARACTERS = 50;

type PdfJs = typeof import('pdfjs-dist/legacy/build/pdf.mjs');

// PDF.js warns with these when it loads without its optional @napi-rs/canvas dependency. That package
// only serves rendering, which this parser never does, and the published CLI bundles PDF.js
// without it (docs/decisions/0006), so the notices would only alarm users.
const CANVAS_NOTICE =
  /^Warning: Cannot (?:load "@napi-rs\/canvas"|polyfill `(?:DOMMatrix|Path2D)`)/;

/** Run `load` with PDF.js's canvas notices filtered out of console.warn, then restore it. */
export async function withoutCanvasNotices<T>(
  load: () => Promise<T>,
): Promise<T> {
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && CANVAS_NOTICE.test(args[0])) return;
    warn(...args);
  };
  try {
    return await load();
  } finally {
    console.warn = warn;
  }
}

let pdfjs: Promise<PdfJs> | undefined;

/**
 * Load PDF.js on first use: it is large, and the CLI should start fast when no PDF is parsed.
 * Its worker runs on this thread from the imported module rather than a file path, so the
 * same code works from node_modules and from the bundled CLI.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= withoutCanvasNotices(async () => {
    const [api, worker] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
    ]);
    (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
    return api;
  });
  return pdfjs;
}

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
const linkAnnotation = z.object({
  subtype: z.literal('Link'),
  rect: z.tuple([z.number(), z.number(), z.number(), z.number()]),
});

interface ExtractedPage extends PageContent {
  /** Visible characters in the text layer, including rotated text. */
  characters: number;
  /** Image paints: a page that only paints images is likely a scan. */
  images: number;
  /** Rotated or vertical text was skipped. */
  skippedRotated: boolean;
}

async function extractPage(
  page: PDFPageProxy,
  pageNumber: number,
  { OPS, AnnotationMode }: PdfJs,
): Promise<ExtractedPage> {
  const content = await page.getTextContent();
  const items: PdfTextItem[] = [];
  let characters = 0;
  let skippedRotated = false;
  for (const raw of content.items) {
    const parsed = textItem.safeParse(raw);
    // Marked-content entries have no text; whitespace-only items (PDF.js emits them for gaps,
    // including one beside every printed line number) carry nothing a gap cannot.
    if (!parsed.success || !/\S/.test(parsed.data.str)) continue;
    characters += parsed.data.str.replace(/\s/g, '').length;
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
  // Annotations are reader markup (a reviewer's strikeout), never the bill's own amendments;
  // only link areas are read, to tell a hyperlink's underline from an insertion.
  const operators = await page.getOperatorList({
    annotationMode: AnnotationMode.DISABLE,
  });
  const links: Rect[] = (await page.getAnnotations()).flatMap((annotation) => {
    const link = linkAnnotation.safeParse(annotation);
    if (!link.success) return [];
    const [x0, y0, x1, y1] = link.data.rect;
    return [
      {
        x0: Math.min(x0, x1),
        y0: Math.min(y0, y1),
        x1: Math.max(x0, x1),
        y1: Math.max(y0, y1),
      },
    ];
  });
  const imageOps = new Set<number>([
    OPS.paintImageXObject,
    OPS.paintInlineImageXObject,
    OPS.paintInlineImageXObjectGroup,
    OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObject,
    OPS.paintImageMaskXObjectGroup,
    OPS.paintImageMaskXObjectRepeat,
  ]);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = page.view;
  return {
    page: pageNumber,
    view: [x0, y0, x1, y1],
    items,
    segments: withoutLinkUnderlines(
      extractMarkSegments(operators.fnArray, operators.argsArray, OPS),
      links,
    ),
    widths: collectGlyphWidths(operators.fnArray, operators.argsArray, OPS),
    characters,
    images: operators.fnArray.filter((fn) => imageOps.has(fn)).length,
    skippedRotated,
  };
}

async function extractPages(bytes: Uint8Array): Promise<ExtractedPage[]> {
  const api = await loadPdfJs();
  // A worker per call keeps parses independent; in Node it runs on this thread.
  const worker = new api.PDFWorker();
  const task = api.getDocument({
    // PDF.js may detach the buffer it is given, and rejects Node Buffers; a plain copy avoids
    // both (Buffer#slice would share the caller's memory).
    data: new Uint8Array(bytes),
    worker,
    // Standard-font metrics are built into PDF.js; the font files only matter for rendering,
    // and extraction is identical without them across every fixture. `useSystemFonts` stops
    // PDF.js fetching them (and warning that no font path was given).
    useSystemFonts: true,
    verbosity: api.VerbosityLevel.ERRORS,
  });
  try {
    let document;
    try {
      document = await task.promise;
    } catch (cause) {
      throw new AppError(
        'PARSE_FAILED',
        cause instanceof api.PasswordException
          ? 'The PDF is password-protected.'
          : 'The PDF could not be opened.',
        { cause },
      );
    }
    const pages: ExtractedPage[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      pages.push(await extractPage(page, number, api));
      // Keep only the extracted geometry; long bills run to thousands of pages.
      page.cleanup();
    }
    return pages;
  } finally {
    await task.destroy();
    worker.destroy();
  }
}

/**
 * Parse a PDF with a text layer. Struck text becomes `deleted` spans and underlined text
 * `inserted` spans; printed line numbers become span and section coordinates. Metadata is
 * left empty for the enrichment step. Throws `SCANNED_PDF` when the document is images with
 * at most a stray stamp of text, and `PARSE_FAILED` when it has no text and no images.
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
  const images = pages.some((page) => page.images > 0);
  if (
    images &&
    pages.every((page) => page.characters < SCANNED_MAX_PAGE_CHARACTERS)
  ) {
    throw new AppError('SCANNED_PDF', 'The PDF is images with no text layer.');
  }
  if (pages.every((page) => page.characters === 0)) {
    throw new AppError('PARSE_FAILED', 'The PDF contains no text.');
  }
  // A page with any text is not a scan, however short ("HB 5" on a cover page).
  const warnings = pages
    .filter((page) => page.characters === 0 && page.images > 0)
    .map(
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
