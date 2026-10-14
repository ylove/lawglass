/**
 * Amendment geometry: which drawn rules are strikethroughs or underlines, and which glyphs
 * they mark. Pure functions over PDF.js output, so every threshold is unit-testable without a
 * PDF. The thresholds and the evidence behind them are in docs/decisions/0006.
 *
 * Coordinates are PDF user space: points, origin at the bottom left, y growing upward.
 */
import type { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import type { SpanStatus } from '../model/index.js';

/** PDF.js's operator codes. Passed in rather than imported, so PDF.js itself loads lazily. */
export type OperatorCodes = typeof OPS;

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
  /**
   * Rise of the baseline per point of x. Scanned pages are slightly skewed (Issue 8 reads
   * 0.008 to 0.012), so a line's baseline climbs across the page. Absent means level.
   */
  slope?: number;
  /** A whitespace-only text item came immediately before this one in the content stream. */
  spaceBefore?: boolean;
}

/** The baseline's height where it crosses x = 0: one value for every item of a skewed line. */
export function lineY(item: Pick<PdfTextItem, 'x' | 'y' | 'slope'>): number {
  return item.y - (item.slope ?? 0) * item.x;
}

/** The baseline's height at `x`, following the item's own direction. */
export function baselineAt(
  item: Pick<PdfTextItem, 'x' | 'y' | 'slope'>,
  x: number,
): number {
  return item.y + (item.slope ?? 0) * (x - item.x);
}

/** A visible horizontal rule after the current transform: a candidate strike or underline. */
export interface MarkSegment {
  x0: number;
  x1: number;
  /** Centre line. */
  y: number;
  thickness: number;
}

/** An axis-aligned rectangle in user space, such as a link annotation's area. */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Advance widths by font, then by character, in the font's own units. */
export type GlyphWidths = ReadonlyMap<string, ReadonlyMap<string, number>>;

export type Matrix = readonly [number, number, number, number, number, number];

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
  /**
   * A typographic rule is at most max(1.5pt, 0.15em) thick. Word draws strikeout about 0.05em
   * thick and Ohio 0.07em, so this allows bold and doubled rules at any size.
   */
  maxThicknessFloor: 1.5,
  maxThicknessEm: 0.15,
  /**
   * Between that cap and 0.5em a rule is a heavy bar: not a mark, but worth a warning because it
   * crosses the text like one. Anything thicker is a highlight or a box, ignored silently.
   */
  maxBarEm: 0.5,
  /** Thinner than this is a hairline (a table grid line, or PDF line width 0): too unclear. */
  hairline: 0.2,
  /** A stroke-only shape taller than this is an outline (a box or table cell), not a rule. */
  maxOutlineHeight: 1,
  /** Shorter than this is a dot or a hyphen-sized artifact. */
  minLength: 0.5,
  /** A glyph takes a mark's status when the mark covers this share of its width. */
  minGlyphCoverage: 0.7,
  /**
   * A real mark hugs the text it marks; Ohio's run on by one trailing space (0.6em). A rule
   * extending further past the text on either side is a table rule or separator.
   */
  maxOverhang: 1.5,
  /**
   * Paint must darken some colour channel by at least this much against the white page, after
   * opacity, to be visible. White cover-up rectangles and fully transparent rules are not marks.
   */
  minInk: 0.1,
  /** Rules in the lowest share of a link annotation's area are link styling, not insertions. */
  linkUnderlineShare: 0.35,
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

/** The largest thickness that still reads as a typographic rule at this font size. */
export function maxMarkThickness(fontSize: number): number {
  return Math.max(
    GEOMETRY.maxThicknessFloor,
    GEOMETRY.maxThicknessEm * fontSize,
  );
}

// PDF.js path data opcodes (its internal DrawOPS, which the package does not export).
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUADRATIC_CURVE_TO = 3;
const CLOSE_PATH = 4;

// PDF.js passes matrices as plain arrays or typed arrays depending on the operator.
export const matrixArgs = z.preprocess(
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
export const formArgs = z.tuple([matrixArgs.nullable(), z.unknown()]);
const lineWidthArgs = z.tuple([z.number()]);
// PDF.js converts every colour space to "#rrggbb" for these operators.
const colourArgs = z.tuple([z.string().regex(/^#[0-9a-f]{6}$/i)]);
const graphicsStateArgs = z.tuple([
  z.array(z.tuple([z.string(), z.unknown()])),
]);
const fontArgs = z.tuple([z.string(), z.unknown()]);
const glyph = z.object({ unicode: z.string(), width: z.number() });

/** `m` then `n`, as PDF's `cm` operator composes them onto the current transform. */
export function concat(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

interface Paint {
  /** Lightest channel, 0 (full ink) to 1 (white). */
  lightness: number;
  alpha: number;
}

/** Ink against a white page: how far the darkest channel falls once opacity is applied. */
function ink({ lightness, alpha }: Paint): number {
  return alpha * (1 - lightness);
}

function paintFromHex(hex: string, alpha: number): Paint {
  const channels = [1, 3, 5].map(
    (start) => Number.parseInt(hex.slice(start, start + 2), 16) / 255,
  );
  return { lightness: Math.min(...channels), alpha };
}

interface GraphicsState {
  ctm: Matrix;
  lineWidth: number;
  fill: Paint;
  stroke: Paint;
}

const BLACK: Paint = { lightness: 0, alpha: 1 };

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
 * A subpath is a candidate mark only when it is horizontal: no curves and wider than tall. A
 * shape painted only by its outline must also be flat, since a stroked box or table cell is
 * not a rule even if its bottom edge runs under text. Thickness is judged later, per text item.
 */
function toSegment(
  path: Subpath,
  ctm: Matrix,
  strokeThickness: number,
  outlineOnly: boolean,
): MarkSegment | undefined {
  if (path.curved || path.points.length < 2) return undefined;
  const points = path.points.map(([x, y]) => apply(ctm, x, y));
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  if (outlineOnly && y1 - y0 > GEOMETRY.maxOutlineHeight) return undefined;
  const thickness = y1 - y0 + strokeThickness;
  const length = x1 - x0;
  if (!Number.isFinite(length + thickness)) return undefined;
  if (length < GEOMETRY.minLength || length <= thickness) return undefined;
  return { x0, x1, y: (y0 + y1) / 2, thickness };
}

/**
 * Collect visible horizontal rules from a page's operator list, tracking the graphics state
 * (save/restore, transform, form XObjects, line width, colour and opacity). Clipping paths are
 * never marks, and neither is paint that leaves no visible ink on a white page.
 */
export function extractMarkSegments(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: OperatorCodes,
): MarkSegment[] {
  const strokes = new Set<number>([
    ops.stroke,
    ops.closeStroke,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  const fills = new Set<number>([
    ops.fill,
    ops.eoFill,
    ops.fillStroke,
    ops.eoFillStroke,
    ops.closeFillStroke,
    ops.closeEOFillStroke,
  ]);
  const segments: MarkSegment[] = [];
  let state: GraphicsState = {
    ctm: [1, 0, 0, 1, 0, 0],
    lineWidth: 1,
    fill: BLACK,
    stroke: BLACK,
  };
  const stack: GraphicsState[] = [];
  fnArray.forEach((fn, index) => {
    const args = argsArray[index];
    switch (fn) {
      case ops.save:
        stack.push(state);
        break;
      case ops.restore:
        state = stack.pop() ?? state;
        break;
      case ops.paintFormXObjectBegin: {
        stack.push(state);
        const matrix = formArgs.safeParse(args).data?.[0];
        if (matrix) state = { ...state, ctm: concat(state.ctm, matrix) };
        break;
      }
      case ops.paintFormXObjectEnd:
        state = stack.pop() ?? state;
        break;
      case ops.transform: {
        const matrix = matrixArgs.safeParse(args);
        if (matrix.success)
          state = { ...state, ctm: concat(state.ctm, matrix.data) };
        break;
      }
      case ops.setLineWidth: {
        const width = lineWidthArgs.safeParse(args);
        if (width.success) state = { ...state, lineWidth: width.data[0] };
        break;
      }
      case ops.setFillRGBColor:
      case ops.setStrokeRGBColor: {
        const hex = colourArgs.safeParse(args).data?.[0];
        if (hex === undefined) break;
        if (fn === ops.setFillRGBColor)
          state = { ...state, fill: paintFromHex(hex, state.fill.alpha) };
        else
          state = { ...state, stroke: paintFromHex(hex, state.stroke.alpha) };
        break;
      }
      // Patterns and shadings: assume visible ink rather than guess at their colour.
      case ops.setFillColorN:
        state = { ...state, fill: { ...BLACK, alpha: state.fill.alpha } };
        break;
      case ops.setStrokeColorN:
        state = { ...state, stroke: { ...BLACK, alpha: state.stroke.alpha } };
        break;
      case ops.setGState: {
        for (const [key, value] of graphicsStateArgs.safeParse(args)
          .data?.[0] ?? []) {
          if (typeof value !== 'number') continue;
          if (key === 'ca')
            state = { ...state, fill: { ...state.fill, alpha: value } };
          if (key === 'CA')
            state = { ...state, stroke: { ...state.stroke, alpha: value } };
          if (key === 'LW') state = { ...state, lineWidth: value };
        }
        break;
      }
      case ops.constructPath: {
        const parsed = pathArgs.safeParse(args);
        if (!parsed.success) break;
        const [paintOp, [data]] = parsed.data;
        const stroked =
          strokes.has(paintOp) && ink(state.stroke) >= GEOMETRY.minInk;
        const filled = fills.has(paintOp) && ink(state.fill) >= GEOMETRY.minInk;
        if (!stroked && !filled) break;
        // A stroke's vertical thickness is its width scaled by the transform's y axis.
        const strokeThickness = stroked
          ? Math.abs(state.lineWidth) * Math.hypot(state.ctm[2], state.ctm[3])
          : 0;
        for (const path of subpaths(data)) {
          const segment = toSegment(path, state.ctm, strokeThickness, !filled);
          if (segment) segments.push(segment);
        }
        break;
      }
    }
  });
  return segments;
}

/**
 * Drop rules along the bottom of a link annotation's area: a hyperlink's underline is link
 * styling, not an insertion. A rule higher in the area (a strike through a link) is kept.
 */
export function withoutLinkUnderlines(
  segments: readonly MarkSegment[],
  links: readonly Rect[],
): MarkSegment[] {
  return segments.filter(
    (segment) =>
      !links.some((link) => {
        const overlap =
          Math.min(segment.x1, link.x1) - Math.max(segment.x0, link.x0);
        const lowest =
          link.y0 + GEOMETRY.linkUnderlineShare * (link.y1 - link.y0);
        return (
          overlap >= GEOMETRY.minGlyphCoverage * (segment.x1 - segment.x0) &&
          segment.y >= link.y0 - GEOMETRY.maxOverhang &&
          segment.y <= lowest
        );
      }),
  );
}

/**
 * Glyph advance widths per font, read from the page's own text-showing operators, so a
 * partly marked text item can be split at true glyph boundaries in proportional fonts.
 */
export function collectGlyphWidths(
  fnArray: readonly number[],
  argsArray: readonly unknown[],
  ops: OperatorCodes,
): GlyphWidths {
  const widths = new Map<string, Map<string, number>>();
  let font: Map<string, number> | undefined;
  fnArray.forEach((fn, index) => {
    if (fn === ops.setFont) {
      const name = fontArgs.safeParse(argsArray[index]).data?.[0];
      if (name === undefined) return;
      font = widths.get(name) ?? new Map<string, number>();
      widths.set(name, font);
    } else if (fn === ops.showText && font) {
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

/**
 * Something about a line's rules a reader should check:
 * - `ambiguous`: a rule crosses the glyphs between the strike and underline bands;
 * - `conflict`: glyphs are both struck and underlined (reported as deleted);
 * - `too-thick`: a rule in a band is too heavy to be a typographic mark;
 * - `hairline`: a rule in a band is too thin to tell from a grid line;
 * - `whole-line`: one rule marks every glyph on the line (a table rule looks the same).
 */
export type MarkIssue =
  'ambiguous' | 'conflict' | 'too-thick' | 'hairline' | 'whole-line';

export interface LineMarks {
  /** Per item, one status per UTF-16 code unit of its text. */
  statuses: SpanStatus[][];
  issues: Set<MarkIssue>;
}

type Bucket = 'deleted' | 'inserted' | 'ambiguous' | 'too-thick' | 'hairline';

/** Which bucket a rule falls in for one item: its band, then whether its weight fits a mark. */
function bucketFor(
  segment: MarkSegment,
  item: PdfTextItem,
): Bucket | undefined {
  // A rule is level but a skewed line's baseline is not: compare at the rule's middle.
  const kind = classifyMarkHeight(segment.y, {
    fontSize: item.fontSize,
    y: baselineAt(item, (segment.x0 + segment.x1) / 2),
  });
  if (!kind || segment.thickness > GEOMETRY.maxBarEm * item.fontSize)
    return undefined;
  if (kind === 'ambiguous') return kind;
  if (segment.thickness > maxMarkThickness(item.fontSize)) return 'too-thick';
  if (segment.thickness < GEOMETRY.hairline) return 'hairline';
  return kind;
}

/**
 * Mark the glyphs of one printed line. A rule counts for an item when it overlaps the item
 * horizontally, sits in one of its bands, has the weight of a typographic rule, and does not
 * overhang the line's text like a table rule. A glyph takes the status when the rule covers
 * `minGlyphCoverage` of its width, so a rule over part of a merged run marks only that part,
 * and a rule through a word gap marks nothing (whitespace never carries status on its own;
 * see pdf-lines.ts).
 *
 * Struck wins over underlined: presenting repealed text as current law is the worse error.
 */
export function markLine(
  items: readonly PdfTextItem[],
  segments: readonly MarkSegment[],
  widths: GlyphWidths,
): LineMarks {
  const result: LineMarks = { statuses: [], issues: new Set() };
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
  // Rules that marked something, and the glyphs (by item) each one covered.
  const marking = new Map<MarkSegment, number>();
  let glyphCount = 0;
  for (const item of items) {
    const buckets: Record<Bucket, MarkSegment[]> = {
      deleted: [],
      inserted: [],
      ambiguous: [],
      'too-thick': [],
      hairline: [],
    };
    for (const segment of hugging) {
      if (segment.x1 <= item.x || segment.x0 >= item.x + item.width) continue;
      const bucket = bucketFor(segment, item);
      if (bucket) buckets[bucket].push(segment);
    }
    const covered = (bucket: Bucket, extent: [number, number]): boolean =>
      buckets[bucket].length > 0 &&
      coverage(extent, buckets[bucket]) >= GEOMETRY.minGlyphCoverage;
    const extents = glyphExtents(item, widths);
    result.statuses.push(
      extents.map((extent, index) => {
        const visible = /\S/.test(item.text[index] ?? '');
        const deleted = covered('deleted', extent);
        const inserted = covered('inserted', extent);
        if (visible) {
          glyphCount++;
          if (deleted && inserted) result.issues.add('conflict');
          for (const segment of [...buckets.deleted, ...buckets.inserted]) {
            if (coverage(extent, [segment]) >= GEOMETRY.minGlyphCoverage)
              marking.set(segment, (marking.get(segment) ?? 0) + 1);
          }
          if (!deleted && !inserted)
            for (const issue of ['ambiguous', 'too-thick', 'hairline'] as const)
              if (covered(issue, extent)) result.issues.add(issue);
        }
        if (deleted) return 'deleted';
        return inserted ? 'inserted' : 'unchanged';
      }),
    );
  }
  if (glyphCount > 0 && [...marking.values()].includes(glyphCount))
    result.issues.add('whole-line');
  return result;
}
