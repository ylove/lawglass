import {
  PDFDocument,
  PDFName,
  StandardFonts,
  beginText,
  concatTransformationMatrix,
  drawObject,
  endText,
  popGraphicsState,
  pushGraphicsState,
  setCharacterSqueeze,
  setFontAndSize,
  setTextMatrix,
  setTextRenderingMode,
  showText,
  TextRenderingMode,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import jpeg from 'jpeg-js';
import {
  CAP_ROWS,
  TOTAL_ROWS,
  X_HEIGHT_TOP_ROW,
  glyphAdvance,
  inkCells,
} from './scanned-font.js';

/**
 * Synthetic "Paper Capture" scans: a page image with strike-through and underline
 * marks in the pixels only, under an invisible (render mode 3) OCR text layer.
 * It exists to test a raster strike/underline detector (issue #193) against exact
 * ground truth, so the geometry is deliberately realistic: word boxes, baseline,
 * x-height, a strike through the middle of the x-height and an underline just
 * below the baseline.
 *
 * Page markup, one string per line, words separated by spaces:
 *   plain          an unchanged word
 *   [-word-]       a struck word (strike-through)
 *   {+word+}       an inserted word (underline)
 *   [-old-]{+new+} one OCR word box spanning struck text then inserted text
 */

export type ScannedStatus = 'unchanged' | 'struck' | 'inserted';

export interface ScannedPdfOptions {
  /** Page markup: pages of lines (see the file comment). */
  pages: string[][];
  /** Raster resolution. Default 144, like the Issue 8 scan. */
  dpi?: number;
  /** Page rotation of the raster only, in degrees (positive = clockwise). Default 0. */
  skewDegrees?: number;
  /** 0 = clean paper, 1 = heavy grain and speckle. Default 0. */
  noise?: number;
  /** Page image encoding. Default 'flate'. */
  encoding?: 'flate' | 'jpeg';
  /** JPEG quality 1-100 (only for 'jpeg'). Default 70. */
  jpegQuality?: number;
  /** Split the page image into this many horizontal strips. Default 1. */
  strips?: number;
  /** Emit the invisible text layer only, with no image. Default false. */
  noImage?: boolean;
  /** Strike and underline thickness in raster pixels. Default 2. */
  markThicknessPx?: number;
  /** PRNG seed for noise. Default 1. */
  seed?: number;
}

export interface ScannedPart {
  text: string;
  status: ScannedStatus;
  /** Character range within the OCR word text. */
  startChar: number;
  endChar: number;
  /** Ink extent of this part in points (before skew). */
  x0: number;
  x1: number;
}

/** A drawn mark, in PDF points with the origin at the bottom left, before skew. */
export interface ScannedMark {
  kind: 'strike' | 'underline';
  x0: number;
  x1: number;
  /** Centre line of the mark. */
  y: number;
  thicknessPt: number;
  /** Index into the word's `parts`. */
  part: number;
}

export interface ScannedWordTruth {
  /** The OCR word text, which is the text item pdfjs returns. */
  text: string;
  /** `mixed` only for a merged OCR word spanning more than one status. */
  status: ScannedStatus | 'mixed';
  line: number;
  /** The OCR box in points (what the invisible text occupies), before skew. */
  box: { x: number; y: number; width: number; height: number };
  baselineY: number;
  /** Top of the lowercase x-height zone. */
  xHeightTopY: number;
  parts: ScannedPart[];
  marks: ScannedMark[];
}

export interface ScannedPageTruth {
  widthPt: number;
  heightPt: number;
  dpi: number;
  skewDegrees: number;
  /** Raster size in pixels of the whole page image (all strips together). */
  widthPx: number;
  heightPx: number;
  /** Row ranges `[start, end)` of each image strip, top to bottom; empty for no image. */
  stripRows: [number, number][];
  /** Words in the same order as the invisible text items. */
  words: ScannedWordTruth[];
}

export interface ScannedPdfTruth {
  pages: ScannedPageTruth[];
}

export interface ScannedPdf {
  bytes: Uint8Array;
  truth: ScannedPdfTruth;
}

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const FONT_PT = 12;
const CELL_PT = FONT_PT / TOTAL_ROWS;
const MARGIN_X = 72;
const MARGIN_TOP = 72;
const LINE_PITCH = 24;
const WORD_GAP_CELLS = 4;
/** A strike runs a little past the word, as a pen stroke does. */
const STRIKE_OVERSHOOT_CELLS = 1;
const UNDERLINE_OVERSHOOT_CELLS = 0.5;
const INK_LEVEL = 25;
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

// ---------------------------------------------------------------------------
// Markup and layout

interface MarkupPart {
  text: string;
  status: ScannedStatus;
}

const PART_PATTERN = /\[-(.+?)-\]|\{\+(.+?)\+\}|([^[{]+)/gy;

/** Splits one whitespace-free token into status parts, e.g. `[-old-]{+new+}`. */
export function parseWordMarkup(token: string): MarkupPart[] {
  const parts: MarkupPart[] = [];
  PART_PATTERN.lastIndex = 0;
  let consumed = 0;
  for (const match of token.matchAll(PART_PATTERN)) {
    consumed += match[0].length;
    if (match[1] !== undefined)
      parts.push({ text: match[1], status: 'struck' });
    else if (match[2] !== undefined)
      parts.push({ text: match[2], status: 'inserted' });
    else if (match[3] !== undefined)
      parts.push({ text: match[3], status: 'unchanged' });
  }
  if (consumed !== token.length || parts.length === 0) {
    throw new Error(`Bad scanned-page markup: ${JSON.stringify(token)}`);
  }
  return parts;
}

function overallStatus(parts: MarkupPart[]): ScannedWordTruth['status'] {
  const first = parts[0]?.status ?? 'unchanged';
  return parts.every((part) => part.status === first) ? first : 'mixed';
}

function layoutPage(
  lines: string[],
  thicknessPt: number,
): { words: ScannedWordTruth[] } {
  const words: ScannedWordTruth[] = [];
  lines.forEach((line, lineIndex) => {
    const tokens = line.split(/\s+/).filter((token) => token !== '');
    const topPt = MARGIN_TOP + lineIndex * LINE_PITCH;
    const baselineY = PAGE_HEIGHT - (topPt + CAP_ROWS * CELL_PT);
    let cursor = MARGIN_X;
    for (const token of tokens) {
      const parts = parseWordMarkup(token);
      const text = parts.map((part) => part.text).join('');
      const truthParts: ScannedPart[] = [];
      let offset = cursor;
      let startChar = 0;
      for (const part of parts) {
        const x0 = offset;
        for (const char of part.text) offset += glyphAdvance(char) * CELL_PT;
        truthParts.push({
          text: part.text,
          status: part.status,
          startChar,
          endChar: startChar + part.text.length,
          // The last glyph's trailing gap is not ink.
          x0,
          x1: offset - CELL_PT,
        });
        startChar += part.text.length;
      }
      const width = offset - CELL_PT - cursor;
      if (topPt + TOTAL_ROWS * CELL_PT > PAGE_HEIGHT - MARGIN_TOP) {
        throw new Error(
          `Scanned-page line ${String(lineIndex + 1)} falls below the bottom margin`,
        );
      }
      if (cursor + width > PAGE_WIDTH - MARGIN_X) {
        throw new Error(
          `Scanned-page line ${String(lineIndex + 1)} is too long`,
        );
      }
      const marks: ScannedMark[] = [];
      truthParts.forEach((part, index) => {
        if (part.status === 'unchanged') return;
        const isStrike = part.status === 'struck';
        // Overshoot only at the OCR word's outer edges, so marks in a merged word
        // meet without overlapping.
        const overshoot =
          (isStrike ? STRIKE_OVERSHOOT_CELLS : UNDERLINE_OVERSHOOT_CELLS) *
          CELL_PT;
        marks.push({
          kind: isStrike ? 'strike' : 'underline',
          x0: part.x0 - (index === 0 ? overshoot : 0),
          x1: part.x1 + (index === truthParts.length - 1 ? overshoot : 0),
          // Strike: middle of the x-height. Underline: just below the baseline.
          y: baselineY + (isStrike ? 2.5 : -1.5) * CELL_PT,
          thicknessPt,
          part: index,
        });
      });
      words.push({
        text,
        status: overallStatus(parts),
        line: lineIndex,
        box: {
          x: cursor,
          y: PAGE_HEIGHT - (topPt + TOTAL_ROWS * CELL_PT),
          width,
          height: TOTAL_ROWS * CELL_PT,
        },
        baselineY,
        xHeightTopY: baselineY + (CAP_ROWS - X_HEIGHT_TOP_ROW) * CELL_PT,
        parts: truthParts,
        marks,
      });
      cursor += width + WORD_GAP_CELLS * CELL_PT;
    }
  });
  return { words };
}

// ---------------------------------------------------------------------------
// Rasterization (grayscale, 255 = white paper)

/** Deterministic PRNG (mulberry32) so a seed reproduces the same grain. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class InkBuffer {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = new Uint8Array(width * height);
  }

  /** Fills a pixel-space rectangle with fractional (anti-aliased) coverage. */
  fillRect(x0: number, y0: number, x1: number, y1: number): void {
    const left = Math.max(0, Math.floor(x0));
    const right = Math.min(this.width, Math.ceil(x1));
    const top = Math.max(0, Math.floor(y0));
    const bottom = Math.min(this.height, Math.ceil(y1));
    for (let y = top; y < bottom; y += 1) {
      const coverY = Math.min(y + 1, y1) - Math.max(y, y0);
      for (let x = left; x < right; x += 1) {
        const coverX = Math.min(x + 1, x1) - Math.max(x, x0);
        const level = Math.round(255 * coverX * coverY);
        const index = y * this.width + x;
        if (level > (this.data[index] ?? 0)) this.data[index] = level;
      }
    }
  }
}

function drawWord(ink: InkBuffer, word: ScannedWordTruth, pxPerPt: number) {
  const cell = CELL_PT * pxPerPt;
  const topPx = (PAGE_HEIGHT - word.box.y - word.box.height) * pxPerPt;
  let x = word.box.x * pxPerPt;
  for (const char of word.text) {
    for (const [column, row] of inkCells(char)) {
      ink.fillRect(
        x + column * cell,
        topPx + row * cell,
        x + (column + 1) * cell,
        topPx + (row + 1) * cell,
      );
    }
    x += glyphAdvance(char) * cell;
  }
  for (const mark of word.marks) {
    const half = (mark.thicknessPt * pxPerPt) / 2;
    const centre = (PAGE_HEIGHT - mark.y) * pxPerPt;
    ink.fillRect(
      mark.x0 * pxPerPt,
      centre - half,
      mark.x1 * pxPerPt,
      centre + half,
    );
  }
}

/** Rotates about the page centre with bilinear sampling; uncovered area is blank. */
function skewInk(ink: InkBuffer, degrees: number): InkBuffer {
  if (degrees === 0) return ink;
  const out = new InkBuffer(ink.width, ink.height);
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = ink.width / 2;
  const cy = ink.height / 2;
  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= ink.width || y >= ink.height
      ? 0
      : (ink.data[y * ink.width + x] ?? 0);
  for (let y = 0; y < ink.height; y += 1) {
    for (let x = 0; x < ink.width; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const sx = cx + dx * cos + dy * sin - 0.5;
      const sy = cy - dx * sin + dy * cos - 0.5;
      const fx = Math.floor(sx);
      const fy = Math.floor(sy);
      const tx = sx - fx;
      const ty = sy - fy;
      out.data[y * ink.width + x] = Math.round(
        at(fx, fy) * (1 - tx) * (1 - ty) +
          at(fx + 1, fy) * tx * (1 - ty) +
          at(fx, fy + 1) * (1 - tx) * ty +
          at(fx + 1, fy + 1) * tx * ty,
      );
    }
  }
  return out;
}

/** Turns ink coverage into 8-bit gray paper, adding grain and speckle. */
function toGray(ink: InkBuffer, noise: number, seed: number): Uint8Array {
  const random = makeRandom(seed);
  const gray = new Uint8Array(ink.data.length);
  for (let i = 0; i < gray.length; i += 1) {
    const coverage = (ink.data[i] ?? 0) / 255;
    let value = 255 - coverage * (255 - INK_LEVEL);
    if (noise > 0) {
      value += (random() + random() - 1) * noise * 40;
      if (random() < noise * 0.0004) value = 60 + random() * 80;
    }
    gray[i] = Math.max(0, Math.min(255, Math.round(value)));
  }
  return gray;
}

// ---------------------------------------------------------------------------
// PDF assembly

function embedStrip(
  doc: PDFDocument,
  gray: Uint8Array,
  width: number,
  rows: [number, number],
  encoding: 'flate' | 'jpeg',
  jpegQuality: number,
) {
  const height = rows[1] - rows[0];
  const pixels = gray.subarray(rows[0] * width, rows[1] * width);
  if (encoding === 'flate') {
    return doc.context.flateStream(pixels, {
      Type: 'XObject',
      Subtype: 'Image',
      Width: width,
      Height: height,
      ColorSpace: 'DeviceGray',
      BitsPerComponent: 8,
    });
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const value = pixels[i] ?? 255;
    rgba.set([value, value, value, 255], i * 4);
  }
  const encoded = jpeg.encode({ data: rgba, width, height }, jpegQuality);
  return doc.context.stream(new Uint8Array(encoded.data), {
    Type: 'XObject',
    Subtype: 'Image',
    Width: width,
    Height: height,
    ColorSpace: 'DeviceRGB',
    BitsPerComponent: 8,
    Filter: 'DCTDecode',
  });
}

function drawInvisibleWord(
  page: PDFPage,
  fontKey: PDFName,
  font: PDFFont,
  word: ScannedWordTruth,
  index: number,
) {
  // Helvetica cap height is 0.718 em; size it so the OCR text spans the bitmap capitals.
  // pdfjs merges neighbouring same-size chunks on a line into one text item (adding
  // spaces). A 0.001pt size change on every other word flushes the item, so there is
  // exactly one text item per OCR word, in order, without visibly changing anything.
  const size = (CAP_ROWS * CELL_PT) / 0.718 + (index % 2) * 0.001;
  // Helvetica is proportional but the bitmap font is not. Scale each character's
  // horizontal size (Tz) so its advance equals its bitmap cell advance; then every
  // character boundary in the OCR text lines up with the raster, which matters inside
  // merged OCR words where a strike stops partway through.
  const perCharacter = Array.from(word.text).flatMap((char) => {
    const natural = font.widthOfTextAtSize(char, size);
    const target = glyphAdvance(char) * CELL_PT;
    return [
      setCharacterSqueeze((target / natural) * 100),
      showText(font.encodeText(char)),
    ];
  });
  // One BT..ET per word keeps pdfjs from merging neighbours into a single text item.
  page.pushOperators(
    beginText(),
    setTextRenderingMode(TextRenderingMode.Invisible),
    setFontAndSize(fontKey, size),
    setTextMatrix(1, 0, 0, 1, word.box.x, word.baselineY),
    ...perCharacter,
    endText(),
  );
}

function splitRows(height: number, strips: number): [number, number][] {
  const base = Math.floor(height / strips);
  const ranges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < strips; i += 1) {
    const end = i === strips - 1 ? height : start + base;
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

function validate(options: ScannedPdfOptions): void {
  const { dpi = 144, strips = 1, noise = 0, markThicknessPx = 2 } = options;
  if (!(dpi >= 50 && dpi <= 300))
    throw new Error(`dpi out of range: ${String(dpi)}`);
  if (!Number.isInteger(strips) || strips < 1 || strips > 64) {
    throw new Error(
      `strips must be an integer from 1 to 64: ${String(strips)}`,
    );
  }
  if (!(noise >= 0 && noise <= 1)) throw new Error(`noise out of range`);
  if (!(markThicknessPx > 0 && markThicknessPx <= 20)) {
    throw new Error(`markThicknessPx out of range: ${String(markThicknessPx)}`);
  }
  if (options.pages.length === 0) throw new Error('pages must not be empty');
}

/** Builds a scanned redline PDF and its exact ground truth. Deterministic per options. */
export async function makeScannedRedlinePdf(
  options: ScannedPdfOptions,
): Promise<ScannedPdf> {
  validate(options);
  const {
    dpi = 144,
    skewDegrees = 0,
    noise = 0,
    encoding = 'flate',
    jpegQuality = 70,
    strips = 1,
    noImage = false,
    markThicknessPx = 2,
    seed = 1,
  } = options;
  const pxPerPt = dpi / 72;
  const widthPx = Math.round(PAGE_WIDTH * pxPerPt);
  const heightPx = Math.round(PAGE_HEIGHT * pxPerPt);

  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setTitle('Synthetic scanned redline');
  doc.setAuthor('Synthetic test generator');
  const font = await doc.embedFont(StandardFonts.Helvetica);

  const truth: ScannedPdfTruth = { pages: [] };
  for (const [pageIndex, lines] of options.pages.entries()) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const { words } = layoutPage(lines, markThicknessPx / pxPerPt);
    const stripRows = noImage ? [] : splitRows(heightPx, strips);

    if (!noImage) {
      const ink = new InkBuffer(widthPx, heightPx);
      for (const word of words) drawWord(ink, word, pxPerPt);
      const gray = toGray(
        skewInk(ink, skewDegrees),
        noise,
        seed + pageIndex * 7919,
      );
      stripRows.forEach((rows, index) => {
        const ref = doc.context.register(
          embedStrip(doc, gray, widthPx, rows, encoding, jpegQuality),
        );
        const name = page.node.newXObject(`Scan${String(index)}`, ref);
        const top = (rows[0] / heightPx) * PAGE_HEIGHT;
        const bottom = (rows[1] / heightPx) * PAGE_HEIGHT;
        page.pushOperators(
          pushGraphicsState(),
          concatTransformationMatrix(
            PAGE_WIDTH,
            0,
            0,
            bottom - top,
            0,
            PAGE_HEIGHT - bottom,
          ),
          drawObject(name),
          popGraphicsState(),
        );
      });
    }

    const fontKey = page.node.newFontDictionary(font.name, font.ref);
    words.forEach((word, index) => {
      drawInvisibleWord(page, fontKey, font, word, index);
    });

    truth.pages.push({
      widthPt: PAGE_WIDTH,
      heightPt: PAGE_HEIGHT,
      dpi,
      skewDegrees,
      widthPx,
      heightPx,
      stripRows,
      words,
    });
  }
  return { bytes: await doc.save(), truth };
}

/**
 * Where a point (PDF points, bottom-left origin, pre-skew) lands on the skewed
 * raster, in the same coordinate system. Use it to compare OCR boxes with ink.
 */
export function inkPositionAfterSkew(
  point: { x: number; y: number },
  skewDegrees: number,
): { x: number; y: number } {
  const radians = (skewDegrees * Math.PI) / 180;
  // Page-image rotation is clockwise on screen; in y-up coordinates that is -radians.
  const dx = point.x - PAGE_WIDTH / 2;
  const dy = point.y - PAGE_HEIGHT / 2;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return {
    x: PAGE_WIDTH / 2 + dx * cos + dy * sin,
    y: PAGE_HEIGHT / 2 - dx * sin + dy * cos,
  };
}

// ---------------------------------------------------------------------------
// Required cases

const CLEAN_PAGE = [
  'Section 4. The council may [-appoint-] a clerk each year.',
  '',
  'The mayor shall {+nominate+} the clerk, and the council shall',
  'confirm the choice within [-thirty-] days.',
  '',
  '{+Each+} {+vacancy+} {+shall+} {+be+} {+filled+} {+within+} {+sixty+} {+days.+}',
  'The salary is set by [-ordinance-] and paid monthly.',
];

export const SCANNED_PRESET_NAMES = [
  'clean',
  'merged',
  'tricky-negatives',
  'short-words',
  'skewed',
  'low-dpi',
  'strips',
  'no-image',
] as const;
export type ScannedPresetName = (typeof SCANNED_PRESET_NAMES)[number];

/**
 * Named cases from issue #191. The comments say what a raster detector should do;
 * the generator itself only records ground truth.
 */
export const SCANNED_PRESETS: Record<ScannedPresetName, ScannedPdfOptions> = {
  // Struck and inserted words on separate lines.
  clean: { pages: [CLEAN_PAGE] },
  // One OCR box spans struck text then inserted text with no space between.
  merged: {
    pages: [
      [
        'The [-clerk-]{+auditor+} shall report to the council.',
        'Each [-town-]{+city+}s budget is public.',
        'The {+city+}[-town-] office opens at nine.',
        'A [-board-]{+commission+}, once formed, shall meet monthly.',
      ],
    ],
  },
  // Letters and dashes that look like marks but are not. Nothing here is struck.
  'tricky-negatives': {
    pages: [
      [
        'These three green trees were seen here.',
        'Her e-mail was well-known; the state-of-the-art re-election',
        'rules - here -- apply to pre-existing offices.',
        'Terms (2020–2024) end - as noted — on election night.',
        'Eleven geese flee the evergreen scene.',
      ],
    ],
  },
  // Struck 1-2 letter words, where the strike barely exceeds the glyph ink.
  'short-words': {
    pages: [
      [
        'The council shall meet [-a-] week to [-be-] heard,',
        'in [-or-] near the hall, [-if-] able, [-so-] that',
        'it may act [-as-] needed {+by+} {+it+} {+an+} {+or+}',
        'the [-I-] and [-we-] shall [-go-] on.',
      ],
    ],
  },
  // A 2 degree page skew: the OCR boxes drift off the ink. Detection should abstain.
  skewed: { pages: [CLEAN_PAGE], skewDegrees: 2 },
  // 90 dpi is below the 100 dpi floor. Detection should abstain.
  'low-dpi': { pages: [CLEAN_PAGE], dpi: 90 },
  // The page image arrives as four JPEG strips, as some scanners write it.
  strips: { pages: [CLEAN_PAGE], strips: 4, encoding: 'jpeg', noise: 0.2 },
  // Invisible text with no readable image at all.
  'no-image': { pages: [CLEAN_PAGE], noImage: true },
};

export function makeScannedPreset(
  name: ScannedPresetName,
  overrides: Partial<ScannedPdfOptions> = {},
): Promise<ScannedPdf> {
  return makeScannedRedlinePdf({ ...SCANNED_PRESETS[name], ...overrides });
}
