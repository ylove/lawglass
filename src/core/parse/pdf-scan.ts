/**
 * OCR-scan detection (issue #192, docs/decisions/0010). A scanned page carries its text as
 * OCR output in one of two forms, and both pass PDF.js as an ordinary text layer:
 *
 * - searchable image: every glyph is drawn invisibly (text render mode 3 or 7) over, or
 *   beside, the page image;
 * - ClearScan (Adobe Paper Capture): visible OCR glyphs over a page-sized background image.
 *
 * Pure functions over PDF.js operator lists, so they test without a PDF.
 */
import { z } from 'zod';
import {
  apply,
  concat,
  formArgs,
  matrixArgs,
  type Matrix,
  type OperatorCodes,
  type Rect,
} from './pdf-geometry.js';

/** One painted image: its transform at paint time and the box it covers in user space. */
export interface ImagePlacement {
  /** Maps the image's unit square to user space; #193 inverts it to read pixels. */
  ctm: Matrix;
  rect: Rect;
}

export interface PageScanStats {
  /** Glyphs shown in a visible render mode. */
  visibleGlyphs: number;
  /** Glyphs shown in render mode 3 or 7 (invisible). */
  invisibleGlyphs: number;
  images: ImagePlacement[];
}

/** How a page was recognised as an OCR scan. */
export type ScanForm = 'invisible-text' | 'clearscan';

/** Text render modes that paint nothing: 3 is invisible, 7 is invisible and adds to the clip. */
const INVISIBLE_MODES = new Set([3, 7]);

/** Most image rectangles considered; a page of thousands of tiles is not worth an exact union. */
const MAX_COVERAGE_RECTS = 256;

/** The image must cover at least this share of the page to be the scan behind ClearScan text. */
export const CLEARSCAN_MIN_COVERAGE = 0.85;

/** Producers and creators of OCR'd scans: Adobe's "Paper Capture Plug-in" and ClearScan, others. */
export const OCR_PRODUCER = /Paper Capture|ClearScan|OCR/i;

const modeArgs = z.tuple([z.number()]);
const shownGlyphs = z.array(z.unknown());

interface ScanState {
  ctm: Matrix;
  mode: number;
}

/** The glyph array a text-showing operator carries, or undefined for other operators. */
function glyphsOf(
  fn: number,
  args: unknown,
  ops: OperatorCodes,
): readonly unknown[] | undefined {
  if (!Array.isArray(args)) return undefined;
  if (fn === ops.showText || fn === ops.nextLineShowText)
    return shownGlyphs.safeParse(args[0]).data;
  if (fn === ops.nextLineSetSpacingShowText)
    return shownGlyphs.safeParse(args[2]).data;
  // Spacing adjustments are numbers between glyphs; only the glyph objects count.
  if (fn === ops.showSpacedText) return shownGlyphs.safeParse(args[0]).data;
  return undefined;
}

/** Glyph objects with ink to show; spacing numbers, nulls and space glyphs are skipped. */
function countGlyphs(entries: readonly unknown[]): number {
  return entries.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { isSpace?: unknown }).isSpace !== true,
  ).length;
}

/**
 * Walk a page's operator list counting visible and invisible glyphs and recording where each
 * image is painted. The text render mode is part of the graphics state, so it is saved and
 * restored with `q`/`Q` and with form XObjects, like the transform.
 */
export function scanOperators(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: OperatorCodes,
): PageScanStats {
  const stats: PageScanStats = {
    visibleGlyphs: 0,
    invisibleGlyphs: 0,
    images: [],
  };
  const paintsImage = new Set<number>([
    ops.paintImageXObject,
    ops.paintInlineImageXObject,
    ops.paintImageMaskXObject,
  ]);
  let state: ScanState = { ctm: [1, 0, 0, 1, 0, 0], mode: 0 };
  const stack: ScanState[] = [];
  fnArray.forEach((fn, index) => {
    const args = argsArray[index];
    if (fn === ops.save) {
      stack.push(state);
    } else if (fn === ops.restore) {
      state = stack.pop() ?? state;
    } else if (fn === ops.paintFormXObjectBegin) {
      stack.push(state);
      const matrix = formArgs.safeParse(args).data?.[0];
      if (matrix) state = { ...state, ctm: concat(state.ctm, matrix) };
    } else if (fn === ops.paintFormXObjectEnd) {
      state = stack.pop() ?? state;
    } else if (fn === ops.transform) {
      const matrix = matrixArgs.safeParse(args);
      if (matrix.success)
        state = { ...state, ctm: concat(state.ctm, matrix.data) };
    } else if (fn === ops.setTextRenderingMode) {
      const mode = modeArgs.safeParse(args);
      if (mode.success) state = { ...state, mode: mode.data[0] };
    } else if (paintsImage.has(fn)) {
      // An image fills the unit square of the current transform.
      const corners = [
        apply(state.ctm, 0, 0),
        apply(state.ctm, 1, 0),
        apply(state.ctm, 0, 1),
        apply(state.ctm, 1, 1),
      ];
      const xs = corners.map(([x]) => x);
      const ys = corners.map(([, y]) => y);
      stats.images.push({
        ctm: state.ctm,
        rect: {
          x0: Math.min(...xs),
          y0: Math.min(...ys),
          x1: Math.max(...xs),
          y1: Math.max(...ys),
        },
      });
    } else {
      const glyphs = glyphsOf(fn, args, ops);
      if (!glyphs) return;
      const count = countGlyphs(glyphs);
      if (INVISIBLE_MODES.has(state.mode)) stats.invisibleGlyphs += count;
      else stats.visibleGlyphs += count;
    }
  });
  return stats;
}

/**
 * Share of the page covered by the union of the image rectangles. A union, because some
 * scanners save one page as several strips, and overlapping tiles must not count twice.
 */
export function imageCoverage(
  images: readonly ImagePlacement[],
  view: Rect,
): number {
  const area = (view.x1 - view.x0) * (view.y1 - view.y0);
  if (!(area > 0)) return 0;
  const rects = images
    .slice(0, MAX_COVERAGE_RECTS)
    .map(({ rect }) => ({
      x0: Math.max(rect.x0, view.x0),
      x1: Math.min(rect.x1, view.x1),
      y0: Math.max(rect.y0, view.y0),
      y1: Math.min(rect.y1, view.y1),
    }))
    .filter((rect) => rect.x1 > rect.x0 && rect.y1 > rect.y0);
  // Sweep across x: in each slab between rectangle edges, add the union of the y intervals.
  const edges = [...new Set(rects.flatMap((rect) => [rect.x0, rect.x1]))].sort(
    (a, b) => a - b,
  );
  let covered = 0;
  for (let index = 1; index < edges.length; index++) {
    const left = edges[index - 1] ?? 0;
    const right = edges[index] ?? 0;
    const spans = rects
      .filter((rect) => rect.x0 <= left && rect.x1 >= right)
      .map((rect): [number, number] => [rect.y0, rect.y1])
      .sort((a, b) => a[0] - b[0]);
    let reach = Number.NEGATIVE_INFINITY;
    let height = 0;
    for (const [start, end] of spans) {
      if (end <= reach) continue;
      height += end - Math.max(start, reach);
      reach = end;
    }
    covered += height * (right - left);
  }
  return Math.min(1, covered / area);
}

/**
 * Whether a page is an OCR scan, and in which form. All-invisible text is a scan whether or
 * not a readable image is present, because PDF.js drops images over `maxImageSize`. Visible
 * text is a scan only when it sits on a page-covering image and the document says an OCR
 * tool made it, so a text PDF with a letterhead image is never flagged.
 */
export function classifyScanPage(
  stats: PageScanStats,
  view: Rect,
  ocrProducer: boolean,
): ScanForm | undefined {
  if (stats.invisibleGlyphs > 0 && stats.visibleGlyphs === 0)
    return 'invisible-text';
  if (
    stats.visibleGlyphs > 0 &&
    ocrProducer &&
    imageCoverage(stats.images, view) >= CLEARSCAN_MIN_COVERAGE
  )
    return 'clearscan';
  return undefined;
}
