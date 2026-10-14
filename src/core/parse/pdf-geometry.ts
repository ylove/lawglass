/**
 * Amendment geometry: which drawn rules are strikethroughs or underlines, and which glyphs
 * they mark. Pure functions over PDF.js output, so every threshold is unit-testable without a
 * PDF. The thresholds and the evidence behind them are in docs/decisions/0006.
 *
 * Coordinates are PDF user space: points, origin at the bottom left, y growing upward.
 */
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import type { SpanStatus } from '../model/index.js';

/** One PDF.js text item, horizontal, in user space. */
export interface PdfTextItem {
  text: string;
  /** Left edge of the first glyph. */
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  /** Em size in points (the text matrix's vertical scale). */
  fontSize: number;
  /** PDF.js's loaded font name; keys the glyph-width table. */
  fontName: string;
}

/** A thin horizontal rule after the current transform: a candidate strike or underline. */
export interface MarkSegment {
  x0: number;
  x1: number;
  /** Centre line. */
  y: number;
  thickness: number;
}

/** Advance widths by font, then by character, in the font's own units. */
export type GlyphWidths = ReadonlyMap<string, ReadonlyMap<string, number>>;

type Matrix = readonly [number, number, number, number, number, number];

/**
 * Thresholds, all relative to the text baseline and in ems of the item's font size so they
 * hold at any point size. See docs/decisions/0006 for the measurements behind each one.
 */
export const GEOMETRY = {
  /**
   * The vertical extent of a text item is a nominal glyph box from -0.2em to +0.8em, PDF.js's
   * own default ascent. Fonts report inconsistent metrics (Times claims an ascent of 0.683em,
   * Ohio's Courier 0.833em), so a fixed box keeps the bands stable across fonts.
   */
  boxBottom: -0.2,
  boxTop: 0.8,
  /** Underlines sit from just above the baseline down to 0.35em below it (Ohio: 0.13 to 0.26em). */
  underlineBottom: -0.35,
  underlineTop: 0.05,
  /** A rule thicker than this is a decorative bar or a redaction, not a typographic mark. */
  maxThickness: 1.5,
  /** Shorter than this is a dot or a hyphen-sized artifact. */
  minLength: 0.5,
  /** A glyph takes a mark's status when the mark covers this share of its width. */
  minGlyphCoverage: 0.7,
  /**
   * A real mark hugs the text it marks; Ohio's run on by one trailing space (0.6em). A rule
   * extending further past the text on either side is a table rule or separator.
   */
  maxOverhang: 1.5,
} as const;

/** The strike band is the middle third of the nominal glyph box: 0.133em to 0.467em. */
const STRIKE_BOTTOM =
  GEOMETRY.boxBottom + (GEOMETRY.boxTop - GEOMETRY.boxBottom) / 3;
const STRIKE_TOP =
  GEOMETRY.boxBottom + ((GEOMETRY.boxTop - GEOMETRY.boxBottom) * 2) / 3;

/** A rule's relation to one text item, from its height above that item's baseline. */
export type MarkKind = 'deleted' | 'inserted' | 'ambiguous';

export function classifyMarkHeight(
  segmentY: number,
  item: Pick<PdfTextItem, 'y' | 'fontSize'>,
): MarkKind | undefined {
  const offset = (segmentY - item.y) / item.fontSize;
  if (offset >= STRIKE_BOTTOM && offset <= STRIKE_TOP) return 'deleted';
  if (offset >= GEOMETRY.underlineBottom && offset <= GEOMETRY.underlineTop)
    return 'inserted';
  // Through the glyphs, but in neither band: too unclear to mark either way.
  if (offset > GEOMETRY.underlineTop && offset < GEOMETRY.boxTop)
    return 'ambiguous';
  return undefined;
}

// PDF.js path data opcodes (its internal DrawOPS, which the package does not export).
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUADRATIC_CURVE_TO = 3;
const CLOSE_PATH = 4;

/** Painting operators whose outline is stroked; the stroke adds to a mark's thickness. */
const STROKE_OPS = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);
const FILL_OPS = new Set<number>([OPS.fill, OPS.eoFill]);

// PDF.js passes matrices as plain arrays or typed arrays depending on the operator.
const matrixArgs = z.preprocess(
  (value) =>
    value instanceof Float32Array || value instanceof Float64Array
      ? Array.from(value)
      : value,
  z.tuple([
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
    z.number(),
  ]),
);
const pathArgs = z.tuple([
  z.number(),
  z.tuple([z.union([z.instanceof(Float32Array), z.array(z.number())])]),
  z.unknown(),
]);
const formArgs = z.tuple([matrixArgs.nullable(), z.unknown()]);
const lineWidthArgs = z.tuple([z.number()]);
const fontArgs = z.tuple([z.string(), z.unknown()]);
const glyph = z.object({ unicode: z.string(), width: z.number() });

/** `m` then `n`, as PDF's `cm` operator composes them onto the current transform. */
function concat(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface Subpath {
  points: [number, number][];
  curved: boolean;
}

/** Split PDF.js path data into subpaths at each moveTo. Curves disqualify a subpath. */
function subpaths(data: ArrayLike<number>): Subpath[] {
  const result: Subpath[] = [];
  let current: Subpath | undefined;
  const at = (index: number): number => data[index] ?? Number.NaN;
  for (let index = 0; index < data.length;) {
    const op = data[index++];
    if (op === MOVE_TO) {
      current = { points: [[at(index), at(index + 1)]], curved: false };
      result.push(current);
      index += 2;
    } else if (op === LINE_TO) {
      current?.points.push([at(index), at(index + 1)]);
      index += 2;
    } else if (op === CURVE_TO || op === QUADRATIC_CURVE_TO) {
      const size = op === CURVE_TO ? 6 : 4;
      if (current) {
        current.curved = true;
        current.points.push([at(index + size - 2), at(index + size - 1)]);
      }
      index += size;
    } else if (op === CLOSE_PATH) {
      const first = current?.points[0];
      if (current && first) current.points.push(first);
    } else {
      // Unknown opcode: stop rather than misread the rest of the path as coordinates.
      break;
    }
  }
  return result;
}

/**
 * A subpath is a candidate mark only when it is a thin horizontal shape: no curves, wider than
 * tall, and at most `maxThickness` tall including the stroke. That admits stroked lines and thin
 * filled bars, and rejects boxes and table cells, whose sides give them height.
 */
function toSegment(
  path: Subpath,
  ctm: Matrix,
  strokeThickness: number,
): MarkSegment | undefined {
  if (path.curved || path.points.length < 2) return undefined;
  const points = path.points.map(([x, y]) => apply(ctm, x, y));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const thickness = y1 - y0 + strokeThickness;
  const length = x1 - x0;
  if (!Number.isFinite(length + thickness)) return undefined;
  if (thickness > GEOMETRY.maxThickness || length < GEOMETRY.minLength)
    return undefined;
  if (length <= thickness) return undefined;
  return { x0, x1, y: (y0 + y1) / 2, thickness };
}

/**
 * Collect thin horizontal rules from a page's operator list, tracking the graphics state
 * (save/restore, transform, form XObjects, line width). Clipping paths are never marks.
 */
export function extractMarkSegments(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
): MarkSegment[] {
  const segments: MarkSegment[] = [];
  let state = { ctm: [1, 0, 0, 1, 0, 0] as Matrix, lineWidth: 1 };
  const stack: (typeof state)[] = [];
  fnArray.forEach((fn, index) => {
    const args = argsArray[index];
    switch (fn) {
      case OPS.save:
        stack.push(state);
        break;
      case OPS.restore:
        state = stack.pop() ?? state;
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(state);
        const matrix = formArgs.safeParse(args).data?.[0];
        if (matrix) state = { ...state, ctm: concat(state.ctm, matrix) };
        break;
      }
      case OPS.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case OPS.transform: {
        const matrix = matrixArgs.safeParse(args);
        if (matrix.success)
          state = { ...state, ctm: concat(state.ctm, matrix.data) };
        break;
      }
      case OPS.setLineWidth: {
        const width = lineWidthArgs.safeParse(args);
        if (width.success) state = { ...state, lineWidth: width.data[0] };
        break;
      }
      case OPS.constructPath: {
        const parsed = pathArgs.safeParse(args);
        if (!parsed.success) break;
        const [paintOp, [data]] = parsed.data;
        const stroked = STROKE_OPS.has(paintOp);
        if (!stroked && !FILL_OPS.has(paintOp)) break;
        // A stroke's vertical thickness is its width scaled by the transform's y axis.
        const strokeThickness = stroked
          ? Math.abs(state.lineWidth) * Math.hypot(state.ctm[2], state.ctm[3])
          : 0;
        for (const path of subpaths(data)) {
          const segment = toSegment(path, state.ctm, strokeThickness);
          if (segment) segments.push(segment);
        }
        break;
      }
    }
  });
  return segments;
}

/**
 * Glyph advance widths per font, read from the page's own text-showing operators, so a
 * partly marked text item can be split at true glyph boundaries in proportional fonts.
 */
export function collectGlyphWidths(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
): GlyphWidths {
  const widths = new Map<string, Map<string, number>>();
  let font: Map<string, number> | undefined;
  fnArray.forEach((fn, index) => {
    if (fn === OPS.setFont) {
      const name = fontArgs.safeParse(argsArray[index]).data?.[0];
      if (name === undefined) return;
      font = widths.get(name) ?? new Map<string, number>();
      widths.set(name, font);
    } else if (fn === OPS.showText && font) {
      const glyphs = z
        .tuple([z.array(z.unknown())])
        .safeParse(argsArray[index]);
      for (const entry of glyphs.data?.[0] ?? []) {
        const parsed = glyph.safeParse(entry);
        if (parsed.success && parsed.data.width > 0)
          font.set(parsed.data.unicode, parsed.data.width);
      }
    }
  });
  return widths;
}

/**
 * Estimated [x0, x1] of each UTF-16 code unit of an item, from glyph widths scaled to the
 * item's measured width. Characters without a known width get the font's average, so the
 * estimate degrades to equal widths (exact for monospace) rather than failing.
 */
export function glyphExtents(
  item: PdfTextItem,
  widths: GlyphWidths,
): [number, number][] {
  const font = widths.get(item.fontName);
  const known = [...(font?.values() ?? [])];
  const average =
    known.length > 0 ? known.reduce((a, b) => a + b, 0) / known.length : 1;
  const chars = Array.from(item.text);
  const advances = chars.map((char) => font?.get(char) ?? average);
  const total = advances.reduce((a, b) => a + b, 0);
  const scale = total > 0 ? item.width / total : 0;
  const extents: [number, number][] = [];
  let x = item.x;
  chars.forEach((char, index) => {
    const next = x + (advances[index] ?? 0) * scale;
    // A character outside the BMP is two code units sharing one glyph.
    for (const _unit of Array.from({ length: char.length }))
      extents.push([x, next]);
    x = next;
  });
  return extents;
}

function coverage(
  [start, end]: readonly [number, number],
  segments: readonly MarkSegment[],
): number {
  const width = end - start;
  if (width <= 0) return 0;
  // Union of the overlaps, so two touching rules over one glyph are not double-counted.
  const overlaps = segments
    .map((segment): [number, number] => [
      Math.max(start, segment.x0),
      Math.min(end, segment.x1),
    ])
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let reach = start;
  for (const [a, b] of overlaps) {
    if (b <= reach) continue;
    covered += b - Math.max(a, reach);
    reach = b;
  }
  return covered / width;
}

export interface LineMarks {
  /** Per item, one status per UTF-16 code unit of its text. */
  statuses: SpanStatus[][];
  /** A rule crossed glyphs between the strike and underline bands. */
  ambiguous: boolean;
  /** Some glyphs were both struck and underlined; they are reported as deleted. */
  conflict: boolean;
}

/**
 * Mark the glyphs of one printed line. A rule counts for an item when it overlaps the item
 * horizontally, sits in one of its bands, and does not overhang the line's text like a table
 * rule. A glyph takes the status when the rule covers `minGlyphCoverage` of its width, so a
 * rule over part of a merged run marks only that part, and a rule through a word gap marks
 * nothing (whitespace never carries status on its own; see pdf-lines.ts).
 *
 * Struck wins over underlined: presenting repealed text as current law is the worse error.
 */
export function markLine(
  items: readonly PdfTextItem[],
  segments: readonly MarkSegment[],
  widths: GlyphWidths,
): LineMarks {
  const result: LineMarks = { statuses: [], ambiguous: false, conflict: false };
  if (items.length === 0) return result;
  const textStart = Math.min(...items.map((item) => item.x));
  const textEnd = Math.max(...items.map((item) => item.x + item.width));
  const em = Math.max(...items.map((item) => item.fontSize));
  const hugging = segments.filter(
    (segment) =>
      segment.x1 > textStart &&
      segment.x0 < textEnd &&
      textStart - segment.x0 <= GEOMETRY.maxOverhang * em &&
      segment.x1 - textEnd <= GEOMETRY.maxOverhang * em,
  );
  for (const item of items) {
    const byKind: Record<MarkKind, MarkSegment[]> = {
      deleted: [],
      inserted: [],
      ambiguous: [],
    };
    for (const segment of hugging) {
      if (segment.x1 <= item.x || segment.x0 >= item.x + item.width) continue;
      const kind = classifyMarkHeight(segment.y, item);
      if (kind) byKind[kind].push(segment);
    }
    const extents = glyphExtents(item, widths);
    const covered = (kind: MarkKind, extent: [number, number]): boolean =>
      byKind[kind].length > 0 &&
      coverage(extent, byKind[kind]) >= GEOMETRY.minGlyphCoverage;
    result.statuses.push(
      extents.map((extent, index) => {
        const glyphChar = item.text[index] ?? '';
        const deleted = covered('deleted', extent);
        const inserted = covered('inserted', extent);
        if (/\S/.test(glyphChar)) {
          if (deleted && inserted) result.conflict = true;
          if (!deleted && !inserted && covered('ambiguous', extent))
            result.ambiguous = true;
        }
        if (deleted) return 'deleted';
        return inserted ? 'inserted' : 'unchanged';
      }),
    );
  }
  return result;
}
