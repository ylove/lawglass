/**
 * Page layout: group text items into printed lines, read the line-number band, drop running
 * headers and footers, and join each line's items into text with per-character amendment
 * statuses. Pure functions; pdf.ts feeds them PDF.js output.
 */
import type { SpanStatus } from '../model/index.js';
import {
  markLine,
  type GlyphWidths,
  type MarkIssue,
  type MarkSegment,
  type PdfTextItem,
} from './pdf-geometry.js';

/** One page's extracted content, in PDF user space. */
export interface PageContent {
  page: number;
  /** PDF.js `page.view`: [x0, y0, x1, y1]. */
  view: readonly [number, number, number, number];
  items: PdfTextItem[];
  segments: MarkSegment[];
  widths: GlyphWidths;
}

/** A printed line ready for section detection. */
export interface StyledLine {
  page: number;
  /** The printed line number, when the page has a line-number band. */
  line?: number;
  /** Left edge of the line's first glyph. */
  x: number;
  text: string;
  /** One amendment status per UTF-16 code unit of `text`. */
  statuses: SpanStatus[];
}

export interface PageLayoutResult {
  lines: StyledLine[];
  warnings: string[];
}

/** Layout thresholds; see docs/decisions/0006. */
export const LAYOUT = {
  /** Items whose baselines differ by at most this many ems share a line. */
  lineTolerance: 0.3,
  /** A horizontal gap of at least this many ems between items is a word space. */
  wordGap: 0.15,
  /** Line numbers align on one edge to within this many points. */
  bandTolerance: 2,
  /** Fewest numbers that establish a band on a page on their own. */
  minBandSize: 3,
  /** Share of steps between consecutive numbers that must be exactly +1. */
  minSequential: 0.8,
  /** Running headers and footers live in this share of the page at the top and bottom. */
  furnitureZone: 0.15,
  /** A header repeats at the same baseline to within this many points. */
  furnitureTolerance: 2,
  /** ...on at least this share of pages (and at least two pages). */
  furnitureRepeat: 0.5,
  /** The same string within this many points of itself is overprinted (fake bold). */
  overprintTolerance: 1,
  /** A gap wider than this many ems between items on a line may be a column gutter... */
  gutterEm: 4,
  /** ...when gaps at the same x (within this many points) recur on enough lines. */
  gutterTolerance: 12,
  minGutterLines: 3,
  gutterShare: 0.25,
  /** In a document without line numbers, body lines start at x positions this common. */
  bodyStartShare: 0.1,
} as const;

const LINE_NUMBER = /^\d{1,6}$/;

interface TextLine {
  page: number;
  y: number;
  items: PdfTextItem[];
  number?: number;
}

/** Group items into lines by baseline, top to bottom, each sorted left to right. */
export function groupLines(items: readonly PdfTextItem[]): PdfTextItem[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];
  for (const item of sorted) {
    const line = lines.at(-1);
    const first = line?.[0];
    if (
      line &&
      first &&
      Math.abs(first.y - item.y) <=
        LAYOUT.lineTolerance * Math.max(first.fontSize, item.fontSize)
    )
      line.push(item);
    else lines.push([item]);
  }
  return lines.map((line) => line.sort((a, b) => a.x - b.x));
}

type BandEdge = 'start' | 'end';

/** Where a document's line numbers sit: the aligned edge, its x, and the margin side. */
export interface LineNumberBand {
  edge: BandEdge;
  at: number;
  side: 'left' | 'right';
}

const edgeOf = (item: PdfTextItem, edge: BandEdge): number =>
  edge === 'start' ? item.x : item.x + item.width;

/**
 * Which margin a candidate number sits in, judged against the other items on its baseline:
 * left if all of them are to its right, right if all are to its left. Undefined if text is
 * on both sides (so it is body text, not a margin number) or it has no neighbours.
 */
function marginSide(
  number: PdfTextItem,
  others: readonly PdfTextItem[],
): 'left' | 'right' | 'both' | undefined {
  const neighbours = others.filter(
    (other) =>
      other !== number &&
      Math.abs(other.y - number.y) <=
        LAYOUT.lineTolerance * Math.max(other.fontSize, number.fontSize),
  );
  if (neighbours.length === 0) return undefined;
  const tolerance = LAYOUT.bandTolerance;
  if (
    neighbours.every((other) => other.x >= number.x + number.width - tolerance)
  )
    return 'left';
  if (
    neighbours.every((other) => other.x + other.width <= number.x + tolerance)
  )
    return 'right';
  return 'both';
}

/** Values read top to bottom must rise, mostly by exactly one. */
function isLineSequence(members: readonly PdfTextItem[]): boolean {
  const values = [...members]
    .sort((a, b) => b.y - a.y)
    .map((item) => Number(item.text.trim()));
  if (values.length < 2) return true;
  let steps = 0;
  for (let index = 1; index < values.length; index++) {
    const step = (values[index] ?? 0) - (values[index - 1] ?? 0);
    if (step <= 0) return false;
    if (step === 1) steps++;
  }
  return steps >= LAYOUT.minSequential * (values.length - 1);
}

/** The page's numbers in `band`; none unless they still count upward down the page. */
function bandMembers(
  items: readonly PdfTextItem[],
  band: LineNumberBand,
): PdfTextItem[] {
  const members = items.filter((item) => {
    if (!LINE_NUMBER.test(item.text.trim())) return false;
    if (Math.abs(edgeOf(item, band.edge) - band.at) > LAYOUT.bandTolerance)
      return false;
    const side = marginSide(item, items);
    return side === undefined || side === band.side;
  });
  return isLineSequence(members) ? members : [];
}

/**
 * Find a page's line-number band: numeric items aligned on one edge (left- or right-aligned
 * numbers), all in the same margin (Ohio prints them on the right, many states on the left),
 * and counting up by one down the page.
 */
export function detectBand(
  items: readonly PdfTextItem[],
): LineNumberBand | undefined {
  const numbers = items.filter((item) => LINE_NUMBER.test(item.text.trim()));
  let best: { band: LineNumberBand; size: number } | undefined;
  for (const edge of ['start', 'end'] as const) {
    const sorted = [...numbers].sort(
      (a, b) => edgeOf(a, edge) - edgeOf(b, edge),
    );
    let cluster: PdfTextItem[] = [];
    const consider = (): void => {
      const first = cluster[0];
      if (!first || cluster.length < LAYOUT.minBandSize) return;
      const sides = new Set(
        cluster.map((item) => marginSide(item, items)).filter(Boolean),
      );
      const side = [...sides][0];
      if (sides.size !== 1 || (side !== 'left' && side !== 'right')) return;
      if (!isLineSequence(cluster)) return;
      if (!best || cluster.length > best.size)
        best = {
          band: { edge, at: edgeOf(first, edge), side },
          size: cluster.length,
        };
    };
    for (const item of sorted) {
      const first = cluster[0];
      if (
        first &&
        edgeOf(item, edge) - edgeOf(first, edge) > LAYOUT.bandTolerance
      ) {
        consider();
        cluster = [];
      }
      cluster.push(item);
    }
    consider();
  }
  return best?.band;
}

/** The band most pages agree on, so short pages (a final line or two) can reuse it. */
function documentBand(
  bands: readonly (LineNumberBand | undefined)[],
): LineNumberBand | undefined {
  let best: { band: LineNumberBand; votes: number } | undefined;
  for (const band of bands) {
    if (!band) continue;
    const votes = bands.filter(
      (other) =>
        other?.edge === band.edge &&
        other.side === band.side &&
        Math.abs(other.at - band.at) <= LAYOUT.bandTolerance,
    ).length;
    if (!best || votes > best.votes) best = { band, votes };
  }
  return best?.band;
}

const normalizeFurniture = (text: string): string =>
  text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();

const PAGE_NUMBER = /^(?:page )?#(?: of #)?$|^[-–—] ?# ?[-–—]$/;

/**
 * Remove running headers and footers: unnumbered lines in the top or bottom zone that are page
 * numbers, or whose text (digits ignored) repeats at the same baseline on enough pages.
 * Numbered lines are body text by definition and are never removed.
 */
function removeFurniture(
  pages: readonly { view: PageContent['view']; lines: TextLine[] }[],
): void {
  const candidates = pages.flatMap(({ view, lines }) => {
    const zone = (view[3] - view[1]) * LAYOUT.furnitureZone;
    return lines
      .filter(
        (line) =>
          line.number === undefined &&
          (line.y >= view[3] - zone || line.y <= view[1] + zone),
      )
      .map((line) => ({
        line,
        key: normalizeFurniture(line.items.map((item) => item.text).join(' ')),
      }));
  });
  const tolerance = LAYOUT.furnitureTolerance;
  const needed = Math.max(2, Math.ceil(pages.length * LAYOUT.furnitureRepeat));
  // Pages showing each text at each whole-point baseline, so a lookup is a few buckets wide.
  const seen = new Map<string, Map<number, Set<number>>>();
  for (const { line, key } of candidates) {
    const byY = seen.get(key) ?? new Map<number, Set<number>>();
    seen.set(key, byY);
    const y = Math.round(line.y);
    byY.set(y, (byY.get(y) ?? new Set<number>()).add(line.page));
  }
  const furniture = new Set<TextLine>();
  for (const { line, key } of candidates) {
    const pagesWithIt = new Set<number>();
    const y = Math.round(line.y);
    for (let near = y - tolerance; near <= y + tolerance; near++)
      for (const page of seen.get(key)?.get(near) ?? []) pagesWithIt.add(page);
    if (PAGE_NUMBER.test(key) || pagesWithIt.size >= needed)
      furniture.add(line);
  }
  for (const page of pages) {
    page.lines = page.lines.filter((line) => !furniture.has(line));
  }
}

/**
 * Join a line's items, inserting a space where the gap between items is a word gap, and
 * collapsing runs of whitespace. Whitespace takes a status only when the text on both sides
 * has it, so a rule through a word gap alone marks nothing, and a struck word between kept
 * words leaves the kept words separated.
 */
export function joinLine(
  items: readonly PdfTextItem[],
  statuses: readonly (readonly SpanStatus[])[],
): { text: string; statuses: SpanStatus[] } {
  const chars: { char: string; status: SpanStatus }[] = [];
  items.forEach((item, index) => {
    const previous = items[index - 1];
    if (previous) {
      const gap = item.x - (previous.x + previous.width);
      if (gap >= LAYOUT.wordGap * Math.min(previous.fontSize, item.fontSize))
        chars.push({ char: ' ', status: 'unchanged' });
    }
    for (let unit = 0; unit < item.text.length; unit++) {
      chars.push({
        char: item.text[unit] ?? '',
        status: statuses[index]?.[unit] ?? 'unchanged',
      });
    }
  });
  const collapsed: typeof chars = [];
  for (const entry of chars) {
    const space = /\s/.test(entry.char);
    if (space && (collapsed.length === 0 || collapsed.at(-1)?.char === ' '))
      continue;
    collapsed.push(space ? { char: ' ', status: entry.status } : entry);
  }
  if (collapsed.at(-1)?.char === ' ') collapsed.pop();
  return {
    text: collapsed.map(({ char }) => char).join(''),
    statuses: collapsed.map(({ char, status }, index) => {
      if (char !== ' ') return status;
      const before = collapsed[index - 1]?.status;
      return before === collapsed[index + 1]?.status && before
        ? before
        : 'unchanged';
    }),
  };
}

/** "Page 3", "Page 3, line 7" or "Page 3, lines 7, 9" (unnumbered lines are not listed). */
function where(page: number, lines: readonly (number | undefined)[]): string {
  const numbered = [...new Set(lines)].filter((line) => line !== undefined);
  if (numbered.length === 0) return `Page ${String(page)}`;
  const label = numbered.length === 1 ? 'line' : 'lines';
  return `Page ${String(page)}, ${label} ${numbered.join(', ')}`;
}

/** What each mark issue means for the reader, appended after "Page N, lines …: ". */
const ISSUE_WARNINGS: Record<MarkIssue, string> = {
  ambiguous:
    'a rule crosses the text but is neither a clear strikethrough nor a clear underline, so that text is treated as unchanged.',
  conflict:
    'some text is both struck through and underlined; it is treated as deleted.',
  'too-thick':
    'a rule through or under the text is too heavy to be a strikethrough or underline (perhaps a bar or highlight), so that text is treated as unchanged; check it.',
  hairline:
    'a hairline rule crosses the text; it is too thin to tell from a table grid line, so that text is treated as unchanged; check it.',
  'whole-line':
    'one rule marks the whole line outside the body text; it may be a table or border rule rather than an amendment, so check it.',
};

/**
 * Remove overprinted duplicates: generators fake bold by drawing the same string twice a
 * fraction of a point apart, which would otherwise read "SectionSection".
 */
export function withoutOverprint(items: readonly PdfTextItem[]): PdfTextItem[] {
  const seen = new Map<string, PdfTextItem[]>();
  return items.filter((item) => {
    const same = seen.get(item.text) ?? [];
    if (
      same.some(
        (other) =>
          Math.abs(other.x - item.x) <= LAYOUT.overprintTolerance &&
          Math.abs(other.y - item.y) <= LAYOUT.overprintTolerance,
      )
    )
      return false;
    seen.set(item.text, [...same, item]);
    return true;
  });
}

/**
 * Whether a page looks like two columns (or a table): several lines share a wide gap at the
 * same x. Lines are read straight across, so such a page's text may be out of order.
 */
export function hasColumnGutter(lines: readonly PdfTextItem[][]): boolean {
  const gutters: number[] = [];
  for (const items of lines) {
    items.slice(1).forEach((item, index) => {
      const previous = items[index];
      if (!previous) return;
      const end = previous.x + previous.width;
      const em = Math.min(previous.fontSize, item.fontSize);
      if (item.x - end > LAYOUT.gutterEm * em) gutters.push((end + item.x) / 2);
    });
  }
  const needed = Math.max(
    LAYOUT.minGutterLines,
    LAYOUT.gutterShare * lines.length,
  );
  return gutters.some(
    (x) =>
      gutters.filter((other) => Math.abs(other - x) <= LAYOUT.gutterTolerance)
        .length >= needed,
  );
}

/** Rounded x positions that at least `share` of the lines start at (within 2pt). */
function commonStarts(lines: readonly TextLine[], share: number): number[] {
  const counts = new Map<number, number>();
  for (const line of lines) {
    const x = Math.round(line.items[0]?.x ?? 0);
    counts.set(x, (counts.get(x) ?? 0) + 1);
  }
  const near = (x: number): number =>
    [...counts]
      .filter(([other]) => Math.abs(other - x) <= LAYOUT.bandTolerance)
      .reduce((total, [, count]) => total + count, 0);
  return [...counts.keys()].filter((x) => near(x) >= share * lines.length);
}

/**
 * Lay out every page: drop overprinted duplicates, detect line numbers (per page, falling back
 * to the band most pages share), group lines, drop running furniture, mark amendments and
 * join text. Pages are processed in order and lines top to bottom, which is reading order for
 * single-column legislation; a page that looks like two columns gets a warning.
 */
export function layoutPages(pages: readonly PageContent[]): PageLayoutResult {
  const warnings: string[] = [];
  const pageItems = pages.map((page) => withoutOverprint(page.items));
  const pageBands = pageItems.map((items) => detectBand(items));
  const fallback = documentBand(pageBands);
  const laidOut = pages.map((page, index) => {
    const items = pageItems[index] ?? [];
    const band = pageBands[index] ?? fallback;
    const numbers = band ? bandMembers(items, band) : [];
    const lines: TextLine[] = groupLines(
      items.filter((item) => !numbers.includes(item)),
    ).map((items) => {
      const y = items[0]?.y ?? 0;
      const em = Math.max(...items.map((item) => item.fontSize));
      const nearest = numbers
        .map((number) => ({ number, distance: Math.abs(number.y - y) }))
        .filter(({ distance }) => distance <= 0.5 * em)
        .sort((a, b) => a.distance - b.distance)[0];
      return {
        page: page.page,
        y,
        items,
        ...(nearest ? { number: Number(nearest.number.text.trim()) } : {}),
      };
    });
    return { page, view: page.view, lines };
  });
  removeFurniture(laidOut);
  if (!fallback && laidOut.some(({ lines }) => lines.length > 0))
    warnings.push(
      'Line numbers were not found in this PDF; citations use page numbers only.',
    );
  for (const { page, lines } of laidOut) {
    if (fallback && lines.length > 0 && lines.every((line) => !line.number))
      warnings.push(
        `Line numbers were not found on page ${String(page.page)}; citations there use the page only.`,
      );
    if (hasColumnGutter(lines.map((line) => line.items)))
      warnings.push(
        `Page ${String(page.page)} looks like it has two columns (or a table); its lines are read straight across, so text there may be out of order.`,
      );
  }

  // Body text is numbered when the document has line numbers; otherwise it starts at the
  // document's common indents. A rule under a whole line elsewhere may be a table rule.
  const starts = commonStarts(
    laidOut.flatMap(({ lines }) => lines),
    LAYOUT.bodyStartShare,
  );
  const inBody = (line: TextLine): boolean =>
    fallback
      ? line.number !== undefined
      : starts.some(
          (x) => Math.abs((line.items[0]?.x ?? 0) - x) <= LAYOUT.bandTolerance,
        );

  const lines: StyledLine[] = [];
  for (const { page, lines: pageLines } of laidOut) {
    const flagged = new Map<MarkIssue, (number | undefined)[]>();
    for (const line of pageLines) {
      const marks = markLine(line.items, page.segments, page.widths);
      for (const issue of marks.issues) {
        if (issue === 'whole-line' && inBody(line)) continue;
        flagged.set(issue, [...(flagged.get(issue) ?? []), line.number]);
      }
      const joined = joinLine(line.items, marks.statuses);
      if (!joined.text) continue;
      lines.push({
        page: page.page,
        ...(line.number === undefined ? {} : { line: line.number }),
        x: line.items[0]?.x ?? 0,
        ...joined,
      });
    }
    for (const [issue, labels] of flagged)
      warnings.push(`${where(page.page, labels)}: ${ISSUE_WARNINGS[issue]}`);
  }
  return { lines, warnings };
}
