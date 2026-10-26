import { describe, expect, it } from 'vitest';
import type { SpanStatus } from '../model/index.js';
import type { MarkSegment, PdfTextItem } from './pdf-geometry.js';
import {
  detectBand,
  groupLines,
  hasColumnGutter,
  joinLine,
  layoutPages,
  withoutOverprint,
  type PageContent,
} from './pdf-lines.js';

const item = (
  text: string,
  x: number,
  y: number,
  overrides: Partial<PdfTextItem> = {},
): PdfTextItem => ({
  text,
  x,
  y,
  width: text.length * 6,
  fontSize: 10,
  fontName: 'mono',
  ...overrides,
});

const page = (
  number: number,
  items: PdfTextItem[],
  segments: MarkSegment[] = [],
): PageContent => ({
  page: number,
  view: [0, 0, 612, 792],
  items,
  segments,
  widths: new Map(),
});

/** Numbered body lines 18pt apart, numbers in the given margin, starting at `first`. */
function numberedPage(
  number: number,
  texts: string[],
  {
    first = 1,
    side = 'left',
  }: { first?: number; side?: 'left' | 'right' } = {},
): PageContent {
  return page(
    number,
    texts.flatMap((text, index) => {
      const y = 650 - index * 18;
      const label = String(first + index);
      return [item(label, side === 'left' ? 36 : 547, y), item(text, 75, y)];
    }),
  );
}

describe('groupLines', () => {
  it('groups items by baseline within a third of an em, top to bottom, left to right', () => {
    const lines = groupLines([
      item('second', 75, 600),
      item('b', 120, 650.5),
      item('a', 75, 652),
      item('far', 75, 640),
    ]);
    expect(lines.map((line) => line.map(({ text }) => text))).toEqual([
      ['a', 'b'],
      ['far'],
      ['second'],
    ]);
  });
});

describe('detectBand', () => {
  it("finds a left band (the synthetic samples') and a right band (Ohio's)", () => {
    expect(detectBand(numberedPage(1, ['a', 'b', 'c']).items)).toEqual({
      edge: 'start',
      at: 36,
      side: 'left',
    });
    expect(
      detectBand(numberedPage(1, ['a', 'b', 'c'], { side: 'right' }).items),
    ).toMatchObject({ side: 'right', at: 547 });
  });

  it('finds right-aligned numbers by their shared end edge', () => {
    const items = ['8', '9', '10', '11'].flatMap((label, index) => {
      const y = 650 - index * 18;
      return [item(label, 60 - label.length * 6, y), item('text', 75, y)];
    });
    expect(detectBand(items)).toEqual({ edge: 'end', at: 60, side: 'left' });
  });

  it('accepts paragraph gaps without numbers but tolerates few skipped numbers', () => {
    const labels = ['1', '2', '3', '4', '5', '7'];
    const items = labels.flatMap((label, index) => [
      item(label, 36, 650 - index * 25),
      item('body', 75, 650 - index * 25),
    ]);
    expect(detectBand(items)).toMatchObject({ side: 'left' });
  });

  it.each([
    ['two numbers', ['1', '2']],
    ['decreasing numbers', ['3', '2', '1']],
    ['a column of amounts', ['100', '250', '400']],
  ])('rejects %s', (_, labels) => {
    const items = labels.flatMap((label, index) => [
      item(label, 36, 650 - index * 18),
      item('body', 75, 650 - index * 18),
    ]);
    expect(detectBand(items)).toBeUndefined();
  });

  it('rejects numbers with text on both sides (body text, not a margin)', () => {
    const items = ['1', '2', '3'].flatMap((label, index) => [
      item('before', 20, 650 - index * 18),
      item(label, 75, 650 - index * 18),
      item('after', 100, 650 - index * 18),
    ]);
    expect(detectBand(items)).toBeUndefined();
  });

  it('rejects a cluster without neighbours to tell its margin', () => {
    expect(
      detectBand(
        ['1', '2', '3'].map((label, index) =>
          item(label, 36, 650 - index * 18),
        ),
      ),
    ).toBeUndefined();
  });
});

describe('joinLine', () => {
  const statuses = (text: string, status: SpanStatus = 'unchanged') =>
    Array.from(text, () => status);

  it('inserts one space at word gaps and none where items touch', () => {
    const items = [
      item('Section', 0, 0, { width: 42 }),
      item('1', 48.3, 0, { width: 6 }),
      item('.', 54.3, 0, { width: 6 }),
      item('That', 66.6, 0, { width: 24 }),
    ];
    expect(
      joinLine(
        items,
        items.map(({ text }) => statuses(text)),
      ),
    ).toEqual({
      text: 'Section 1. That',
      statuses: statuses('Section 1. That'),
    });
  });

  it('collapses whitespace runs and trims the ends', () => {
    const items = [item('  a   b ', 0, 0, { width: 48 }), item(' c', 60, 0)];
    expect(
      joinLine(
        items,
        items.map(({ text }) => statuses(text)),
      ).text,
    ).toBe('a b c');
  });

  it('gives whitespace a status only when the text on both sides has it', () => {
    const items = [
      item('keep', 0, 0, { width: 24 }),
      item('old words', 30, 0, { width: 54 }),
      item('new', 90, 0, { width: 18 }),
      item('more new', 114, 0, { width: 48 }),
    ];
    const joined = joinLine(items, [
      statuses('keep'),
      statuses('old words', 'deleted'),
      statuses('new', 'inserted'),
      statuses('more new', 'inserted'),
    ]);
    expect(joined.text).toBe('keep old words new more new');
    const runs: string[] = [];
    joined.statuses.forEach((status, index) => {
      const char = joined.text[index]!;
      const last = runs.at(-1);
      if (last?.startsWith(`${status}:`)) runs[runs.length - 1] = last + char;
      else runs.push(`${status}:${char}`);
    });
    expect(runs).toEqual([
      'unchanged:keep ',
      'deleted:old words',
      'unchanged: ',
      'inserted:new more new',
    ]);
  });

  it('never lets a rule through a word gap mark the gap', () => {
    const joined = joinLine(
      [item('a', 0, 0, { width: 6 }), item('b', 60, 0, { width: 6 })],
      [['unchanged'], ['unchanged']],
    );
    expect(joined).toEqual({
      text: 'a b',
      statuses: ['unchanged', 'unchanged', 'unchanged'],
    });
  });
});

describe('layoutPages', () => {
  it('numbers lines from the band, removes the numbers, and keeps reading order', () => {
    const result = layoutPages([
      numberedPage(1, ['first line', 'second line'].concat('third')),
    ]);
    expect(result.lines).toEqual([
      expect.objectContaining({ page: 1, line: 1, x: 75, text: 'first line' }),
      expect.objectContaining({ page: 1, line: 2, text: 'second line' }),
      expect.objectContaining({ page: 1, line: 3, text: 'third' }),
    ]);
    expect(result.warnings).toEqual([]);
  });

  it("follows numbering that continues across pages, as Ohio's does", () => {
    const result = layoutPages([
      numberedPage(1, ['a', 'b', 'c'], { side: 'right' }),
      numberedPage(2, ['d', 'e', 'f'], { side: 'right', first: 4 }),
    ]);
    expect(result.lines.map(({ page, line }) => [page, line])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
      [2, 4],
      [2, 5],
      [2, 6],
    ]);
  });

  it("reuses the document's band on a page too short to establish its own", () => {
    const result = layoutPages([
      numberedPage(1, ['a', 'b', 'c']),
      numberedPage(2, ['last line'], { first: 4 }),
    ]);
    expect(result.lines.at(-1)).toMatchObject({
      page: 2,
      line: 4,
      text: 'last line',
    });
    expect(result.warnings).toEqual([]);
  });

  it('warns when a page in a numbered document has no line numbers', () => {
    const result = layoutPages([
      numberedPage(1, ['a', 'b', 'c']),
      page(2, [item('unnumbered appendix', 75, 600)]),
    ]);
    expect(result.lines.at(-1)).not.toHaveProperty('line');
    expect(result.warnings).toEqual([
      'Line numbers were not found on page 2; citations there use the page only.',
    ]);
  });

  it('warns once when the document has no line numbers at all', () => {
    const result = layoutPages([
      page(1, [item('Sec. 1.', 72, 700)]),
      page(2, []),
    ]);
    expect(result.warnings).toEqual([
      'Line numbers were not found in this PDF; citations use page numbers only.',
    ]);
    expect(layoutPages([]).warnings).toEqual([]);
  });

  it('removes running headers and page numbers, but never numbered body lines', () => {
    const pages = [1, 2, 3].map((number) => {
      const body = numberedPage(
        number,
        ['Body text', 'Body text', 'Body text'],
        {
          first: number * 3 - 2,
        },
      );
      body.items.push(
        item('S. B. No. 203', 72, 707),
        item(`Page ${String(number)}`, 500, 707),
        item('As Introduced', 72, 695.5),
        item(`- ${String(number)} -`, 300, 30),
      );
      return body;
    });
    // A title that appears once in the header zone is kept (metadata needs it).
    pages[0]!.items.push(item('As Introduced', 250, 740, { fontSize: 13 }));
    const texts = layoutPages(pages).lines.map(({ text }) => text);
    expect(texts.filter((text) => text === 'Body text')).toHaveLength(9);
    expect(texts).toContain('As Introduced');
    expect(texts.filter((text) => text === 'As Introduced')).toHaveLength(1);
    expect(texts.join('\n')).not.toMatch(/S\. B\. No|Page \d|- \d -/);
  });

  it('removes a lone page number even in a one-page document, and keeps other top lines', () => {
    const texts = layoutPages([
      page(1, [
        item('A BILL', 250, 760),
        item('Sec. 1. Body.', 72, 500),
        item('1', 300, 30),
      ]),
    ]).lines.map(({ text }) => text);
    expect(texts).toEqual(['A BILL', 'Sec. 1. Body.']);
  });

  it('marks amendments and reports ambiguous and conflicting marks by line', () => {
    const content = numberedPage(1, ['old new', 'unclear', 'both']);
    // y = 650 - 18 * index; strike band 1.33-4.67pt above, underline 3.5pt below to 0.5 above.
    content.segments = [
      { x0: 75, x1: 93, y: 653, thickness: 0.6 },
      { x0: 99, x1: 117, y: 649, thickness: 0.6 },
      { x0: 75, x1: 117, y: 632.9, thickness: 0.6 },
      { x0: 75, x1: 99, y: 617, thickness: 0.6 },
      { x0: 75, x1: 99, y: 613, thickness: 0.6 },
    ];
    const result = layoutPages([content]);
    expect(result.lines[0]?.statuses.join(',')).toBe(
      'deleted,deleted,deleted,unchanged,inserted,inserted,inserted',
    );
    expect(result.lines[1]?.statuses).not.toContain('deleted');
    expect(result.lines[2]?.statuses).toEqual(
      Array.from('both', () => 'deleted'),
    );
    expect(result.warnings).toEqual([
      'Page 1, line 2: a rule crosses the text but is neither a clear strikethrough nor a clear underline, so that text is treated as unchanged.',
      'Page 1, line 3: some text is both struck through and underlined; it is treated as deleted.',
    ]);
  });

  it('names the page alone when an ambiguous mark is on an unnumbered line', () => {
    const content = page(1, [item('Title', 72, 600), item('Sec. 1.', 72, 500)]);
    content.segments = [{ x0: 72, x1: 102, y: 601, thickness: 0.5 }];
    expect(layoutPages([content]).warnings).toContain(
      'Page 1: a rule crosses the text but is neither a clear strikethrough nor a clear underline, so that text is treated as unchanged.',
    );
  });

  it('lists several ambiguous lines on one page together', () => {
    const content = numberedPage(1, ['aa', 'bb', 'cc']);
    content.segments = [650, 632, 614].map((y) => ({
      x0: 75,
      x1: 87,
      y: y + 1,
      thickness: 0.5,
    }));
    expect(layoutPages([content]).warnings[0]).toMatch(
      /^Page 1, lines 1, 2, 3:/,
    );
  });
});

describe('withoutOverprint (review finding 6)', () => {
  it('drops the same string redrawn within a point (fake bold), keeping real repeats', () => {
    const items = [
      item('Section', 72, 700),
      item('Section', 72.3, 700.2),
      item('1.', 120, 700),
      item('Section', 72, 600),
      item('Section', 74, 700),
    ];
    expect(withoutOverprint(items)).toEqual([
      items[0],
      items[2],
      items[3],
      items[4],
    ]);
  });

  it('reads overprinted text once in the laid-out line', () => {
    const bold = page(1, [
      item('Section 1. The quick fox.', 72, 700),
      item('Section 1. The quick fox.', 72.3, 700),
    ]);
    expect(layoutPages([bold]).lines.map(({ text }) => text)).toEqual([
      'Section 1. The quick fox.',
    ]);
  });
});

describe('hasColumnGutter (review finding 5)', () => {
  const twoColumns = [0, 1, 2, 3].map((index) => [
    item('left column text', 72, 700 - index * 14),
    item('right column text', 330, 700 - index * 14),
  ]);

  it('sees a gap shared by several lines at the same x', () => {
    expect(hasColumnGutter(twoColumns)).toBe(true);
  });

  it('ignores one wide gap (a title line) and ordinary word spacing', () => {
    expect(
      hasColumnGutter([
        [item('Regular Session', 99, 645), item('S. B. No. 113', 424, 645)],
        ...[1, 2, 3, 4].map((index) => [
          item('the board', 75, 600 - index * 18),
          item('shall adopt', 141, 600 - index * 18),
        ]),
      ]),
    ).toBe(false);
  });

  it('warns about a two-column page in the layout', () => {
    const result = layoutPages([page(1, twoColumns.flat())]);
    expect(result.warnings).toContain(
      'Page 1 looks like it has two columns (or a table); its lines are read straight across, so text there may be out of order.',
    );
  });
});

describe('heavy, hairline and whole-line rules in the layout', () => {
  it('names lines with rules too heavy or too thin to be marks', () => {
    const content = numberedPage(1, ['brown fox', 'lazy dog', 'plain']);
    content.segments = [
      { x0: 75, x1: 129, y: 653, thickness: 3 },
      { x0: 75, x1: 123, y: 635, thickness: 0.1 },
    ];
    const result = layoutPages([content]);
    expect(result.lines.flatMap((line) => line.statuses)).not.toContain(
      'deleted',
    );
    expect(result.warnings).toEqual([
      'Page 1, line 1: a rule through or under the text is too heavy to be a strikethrough or underline (perhaps a bar or highlight), so that text is treated as unchanged; check it.',
      'Page 1, line 2: a hairline rule crosses the text; it is too thin to tell from a table grid line, so that text is treated as unchanged; check it.',
    ]);
  });

  it('does not question a whole underlined line in numbered body text (an Ohio new section)', () => {
    const content = numberedPage(1, [
      'new law text',
      'more new text',
      'and more',
    ]);
    content.segments = [650, 632, 614].map((y) => ({
      x0: 75,
      x1: 160,
      y: y - 1.4,
      thickness: 0.7,
    }));
    const result = layoutPages([content]);
    expect(result.lines[0]?.statuses).not.toContain('unchanged');
    expect(result.warnings).toEqual([]);
  });

  it('questions a whole-line rule on an unnumbered line of a numbered document', () => {
    const content = numberedPage(1, ['body', 'body', 'body']);
    content.items.push(item('Fee table', 300, 500));
    content.segments = [{ x0: 300, x1: 354, y: 497, thickness: 0.5 }];
    expect(layoutPages([content]).warnings).toEqual([
      'Page 1: one rule marks the whole line outside the body text; it may be a table or border rule rather than an amendment, so check it.',
    ]);
  });

  it('judges the body by common indents when a document has no line numbers', () => {
    const body = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((index) =>
      item('Body text line', 72, 700 - index * 14),
    );
    const cell = item('Cell', 400, 500);
    const content = page(1, [...body, cell]);
    content.segments = [
      { x0: 72, x1: 156, y: 698.6, thickness: 0.6 },
      { x0: 400, x1: 424, y: 498.6, thickness: 0.6 },
    ];
    expect(layoutPages([content]).warnings).toEqual([
      'Line numbers were not found in this PDF; citations use page numbers only.',
      'Page 1: one rule marks the whole line outside the body text; it may be a table or border rule rather than an amendment, so check it.',
    ]);
  });
});

it('exempts only the NY cover enacting clause from whole-line warnings, retaining an unrelated table warning', () => {
  const content = numberedPage(1, ['Section 1. Body.', 'body', 'body']);
  content.items.push(item('The People of the State of New York,', 72, 710));
  content.items.push(
    item('represented in Senate and Assembly, do enact as follows:', 72, 692),
  );
  content.segments = [
    { x0: 72, x1: 288, y: 708.6, thickness: 0.6 },
    { x0: 72, x1: 408, y: 690.6, thickness: 0.6 },
  ];
  expect(layoutPages([content], { newYorkBill: true }).warnings).toEqual([]);
  expect(layoutPages([content]).warnings.join(' ')).toContain(
    'one rule marks the whole line',
  );
  content.items.push(item('Fee table', 300, 500));
  content.segments.push({ x0: 300, x1: 354, y: 497, thickness: 0.5 });
  expect(
    layoutPages([content], { newYorkBill: true }).warnings.join(' '),
  ).toContain('one rule marks the whole line');
});
