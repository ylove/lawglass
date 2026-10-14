import {
  PDFDocument,
  StandardFonts,
  beginMarkedContent,
  endMarkedContent,
  rgb,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import type { Section, SpanStatus } from '../../src/core/model/index.js';
import type { SampleGroundTruth, SyntheticSample } from './types.js';

export interface PdfDecoration {
  text: string;
  status: 'deleted' | 'inserted';
  shape: 'line' | 'rect';
  page: number;
  line: number;
  x: number;
  y: number;
  width: number;
  thickness: number;
}

export interface PdfGroundTruth extends SampleGroundTruth {
  pages: {
    page: number;
    lines: Record<number, string>;
    header: string;
    footer: string;
  }[];
  expectedSectionNumbers: string[];
  decorations: PdfDecoration[];
  layout: {
    pageWidth: number;
    pageHeight: number;
    lineNumberX: number;
    textX: number;
    firstLineY: number;
    lineSpacing: number;
    fontSize: number;
  };
}

const LAYOUT: PdfGroundTruth['layout'] = {
  pageWidth: 612,
  pageHeight: 792,
  lineNumberX: 36,
  textX: 72,
  firstLineY: 640,
  lineSpacing: 22,
  fontSize: 11,
};
const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

async function newDocument(): Promise<PDFDocument> {
  // pdf-lib defaults these to the clock; fixed metadata makes doc hashes reproducible.
  const doc = await PDFDocument.create();
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setTitle('Synthetic legislation sample');
  doc.setAuthor('Synthetic test generator');
  return doc;
}

function drawDecoration(page: PDFPage, mark: PdfDecoration): void {
  if (mark.shape === 'line') {
    page.drawLine({
      start: { x: mark.x, y: mark.y },
      end: { x: mark.x + mark.width, y: mark.y },
      thickness: mark.thickness,
      color: rgb(0, 0, 0),
    });
  } else {
    page.drawRectangle({
      x: mark.x,
      y: mark.y,
      width: mark.width,
      height: mark.thickness,
      color: rgb(0, 0, 0),
    });
  }
}

function drawAmendedLine(
  page: PDFPage,
  font: PDFFont,
  text: string,
  pageNumber: number,
  line: number,
  decorations: PdfDecoration[],
): void {
  const y = LAYOUT.firstLineY - (line - 1) * LAYOUT.lineSpacing;
  page.drawText(String(line), { x: LAYOUT.lineNumberX, y, font, size: 8 });
  const amendments: {
    text: string;
    status: 'deleted' | 'inserted';
    shape: 'line' | 'rect';
  }[] = [
    { text: 'the obsolete credit', status: 'deleted', shape: 'line' },
    { text: 'the community garden credit', status: 'inserted', shape: 'rect' },
    { text: 'a paper report', status: 'deleted', shape: 'rect' },
    { text: 'an electronic report', status: 'inserted', shape: 'line' },
  ];
  let offset = 0;
  let x = LAYOUT.textX;
  // Generic marked-content boundaries prevent PDF.js from merging amendment runs.
  // They carry no amendment status: a parser still has to inspect the drawn geometry.
  for (const amendment of amendments) {
    const start = text.indexOf(amendment.text, offset);
    if (start < 0) continue;
    const before = text.slice(offset, start);
    if (before) page.drawText(before, { x, y, font, size: LAYOUT.fontSize });
    x += font.widthOfTextAtSize(before, LAYOUT.fontSize);
    page.pushOperators(beginMarkedContent('Span'));
    page.drawText(amendment.text, { x, y, font, size: LAYOUT.fontSize });
    page.pushOperators(endMarkedContent());
    const width = font.widthOfTextAtSize(amendment.text, LAYOUT.fontSize);
    const mark: PdfDecoration = {
      ...amendment,
      page: pageNumber,
      line,
      x,
      width,
      thickness: 0.6,
      y: y + (amendment.status === 'deleted' ? LAYOUT.fontSize * 0.4 : -0.8),
    };
    drawDecoration(page, mark);
    decorations.push(mark);
    x += width;
    offset = start + amendment.text.length;
  }
  const after = text.slice(offset);
  if (after) page.drawText(after, { x, y, font, size: LAYOUT.fontSize });
}

function span(
  text: string,
  page: number,
  line: number,
  status: SpanStatus = 'unchanged',
) {
  return { text, page, line, status };
}

function amendingSections(pageCount: number): Section[] {
  const sections: Section[] = [
    {
      id: 'sec-1',
      num: '1',
      level: 1,
      children: [],
      pageStart: 1,
      pageEnd: 1,
      lineStart: 1,
      lineEnd: 2,
      spans: [
        span('That section 5747.01 of the Revised Code be amended', 1, 1),
        span(' to read as follows:', 1, 2),
      ],
    },
    {
      id: 'sec-5747.01',
      num: '5747.01',
      heading: 'Definitions',
      level: 1,
      pageStart: 1,
      pageEnd: 2,
      lineStart: 3,
      lineEnd: 3,
      spans: [],
      children: [
        {
          id: 'sec-5747.01/A',
          num: '(A)',
          level: 2,
          pageStart: 1,
          pageEnd: 1,
          lineStart: 4,
          lineEnd: 8,
          spans: [span('As used in this chapter:', 1, 4)],
          children: [
            {
              id: 'sec-5747.01/A/1',
              num: '(1)',
              level: 3,
              children: [],
              pageStart: 1,
              pageEnd: 1,
              lineStart: 5,
              lineEnd: 6,
              spans: [
                span('"Adjusted gross income" means income after ', 1, 5),
                span('the obsolete credit', 1, 6, 'deleted'),
                span(' ', 1, 6),
                span('the community garden credit', 1, 6, 'inserted'),
                span('.', 1, 6),
              ],
            },
            {
              id: 'sec-5747.01/A/2',
              num: '(2)',
              level: 3,
              children: [],
              pageStart: 1,
              pageEnd: 1,
              lineStart: 7,
              lineEnd: 8,
              spans: [
                span('A grantee shall submit ', 1, 7),
                span('a paper report', 1, 7, 'deleted'),
                span(' ', 1, 7),
                span('an electronic report', 1, 7, 'inserted'),
                span('.', 1, 7),
                span(' The report shall state the planting season.', 1, 8),
              ],
            },
          ],
        },
        {
          id: 'sec-5747.01/B',
          num: '(B)',
          heading: 'Grant administration',
          level: 2,
          pageStart: 2,
          pageEnd: 2,
          lineStart: 1,
          lineEnd: 3,
          spans: [],
          children: [
            {
              id: 'sec-5747.01/B/1',
              num: '(1)',
              level: 3,
              children: [],
              pageStart: 2,
              pageEnd: 2,
              lineStart: 2,
              lineEnd: 2,
              spans: [span('The department shall publish award totals.', 2, 2)],
            },
            {
              id: 'sec-5747.01/B/2',
              num: '(2)',
              level: 3,
              children: [],
              pageStart: 2,
              pageEnd: 2,
              lineStart: 3,
              lineEnd: 3,
              spans: [
                span(
                  'A grant may support seed libraries and shared tools.',
                  2,
                  3,
                ),
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'sec-2',
      num: '2',
      heading: 'Effective date',
      level: 1,
      children: [],
      pageStart: 2,
      pageEnd: 2,
      lineStart: 4,
      lineEnd: 5,
      spans: [span('This act takes effect ninety days after passage.', 2, 5)],
    },
  ];
  if (pageCount === 3)
    sections.push({
      id: 'sec-3',
      num: '3',
      heading: 'Reports',
      level: 1,
      children: [],
      pageStart: 3,
      pageEnd: 3,
      lineStart: 1,
      lineEnd: 3,
      spans: [
        span('The department shall send an annual report', 3, 2),
        span(' to the General Assembly.', 3, 3),
      ],
    });
  return sections;
}

export interface AmendingBillPdfOptions {
  /** Two pages by default; a third adds a reporting section. */
  pageCount?: number;
}

export async function makeAmendingBillPdf(
  opts: AmendingBillPdfOptions = {},
): Promise<SyntheticSample<PdfGroundTruth>> {
  const pageCount = opts.pageCount ?? 2;
  if (pageCount !== 2 && pageCount !== 3)
    throw new RangeError('Amending bill PDF must have 2 or 3 pages.');
  const doc = await newDocument();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const texts = [
    [
      'Section 1. That section 5747.01 of the Revised Code be amended',
      'to read as follows:',
      'Sec. 5747.01. Definitions.',
      '(A) As used in this chapter:',
      '(1) "Adjusted gross income" means income after',
      'the obsolete credit the community garden credit.',
      '(2) A grantee shall submit a paper report an electronic report.',
      'The report shall state the planting season.',
    ],
    [
      '(B) Grant administration.',
      '(1) The department shall publish award totals.',
      '(2) A grant may support seed libraries and shared tools.',
      'Section 2. Effective date.',
      'This act takes effect ninety days after passage.',
    ],
  ];
  if (pageCount === 3)
    texts.push([
      'Section 3. Reports.',
      'The department shall send an annual report',
      'to the General Assembly.',
    ]);
  const groundTruth: PdfGroundTruth = {
    layout: { ...LAYOUT },
    pages: [],
    sections: amendingSections(pageCount),
    decorations: [],
    expectedSectionNumbers:
      pageCount === 3 ? ['1', '5747.01', '2', '3'] : ['1', '5747.01', '2'],
    deletedStrings: ['the obsolete credit', 'a paper report'],
    insertedStrings: ['the community garden credit', 'an electronic report'],
  };
  texts.forEach((lines, pageIndex) => {
    const pageNumber = pageIndex + 1;
    const page = doc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
    const header = 'As Introduced';
    const footer = String(pageNumber);
    page.drawText(header, { x: 250, y: 754, size: 10, font });
    page.drawText(footer, { x: 302, y: 30, size: 10, font });
    if (pageNumber === 1) {
      page.drawText('SYNTHETIC GENERAL ASSEMBLY', {
        x: 170,
        y: 714,
        size: 12,
        font,
      });
      page.drawText('H. B. No. 9001 - Community Garden Credits', {
        x: 155,
        y: 690,
        size: 12,
        font,
      });
    }
    groundTruth.pages.push({
      page: pageNumber,
      header,
      footer,
      lines: Object.fromEntries(lines.map((text, i) => [i + 1, text])),
    });
    lines.forEach((text, index) => {
      drawAmendedLine(
        page,
        font,
        text,
        pageNumber,
        index + 1,
        groundTruth.decorations,
      );
    });
  });
  return { bytes: await doc.save({ useObjectStreams: false }), groundTruth };
}

export async function makeScannedPdf(): Promise<SyntheticSample> {
  const doc = await newDocument();
  const page = doc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  // Draw raster-like bands only: no fonts, text operators, or hidden searchable text.
  for (let line = 0; line < 12; line++) {
    page.drawRectangle({
      x: 72,
      y: 680 - line * 24,
      width: 360 - (line % 3) * 50,
      height: 6,
      color: rgb(0.2, 0.2, 0.2),
    });
  }
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    groundTruth: { sections: [], deletedStrings: [], insertedStrings: [] },
  };
}

export async function makeFederalStylePdf(): Promise<SyntheticSample> {
  const doc = await newDocument();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const page = doc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
  const lines = [
    'S. 9002',
    'A BILL',
    'SEC. 1. Short title.',
    'This Act may be cited as the Seed Library Act.',
    'SEC. 2. Grants.',
    '(a) Eligibility.',
    '(1) A town may apply for a seed library grant.',
    '(2) The town shall provide a public planting calendar.',
  ];
  lines.forEach((text, index) => {
    page.drawText(text, { x: 72, y: 710 - index * 24, size: 11, font });
  });
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    groundTruth: {
      deletedStrings: [],
      insertedStrings: [],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Short title',
          level: 1,
          children: [],
          pageStart: 1,
          pageEnd: 1,
          spans: [
            {
              text: 'This Act may be cited as the Seed Library Act.',
              status: 'unchanged',
              page: 1,
            },
          ],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Grants',
          level: 1,
          spans: [],
          pageStart: 1,
          pageEnd: 1,
          children: [
            {
              id: 'sec-2/a',
              num: '(a)',
              heading: 'Eligibility',
              level: 2,
              spans: [],
              pageStart: 1,
              pageEnd: 1,
              children: [
                {
                  id: 'sec-2/a/1',
                  num: '(1)',
                  level: 3,
                  children: [],
                  pageStart: 1,
                  pageEnd: 1,
                  spans: [
                    {
                      text: 'A town may apply for a seed library grant.',
                      status: 'unchanged',
                      page: 1,
                    },
                  ],
                },
                {
                  id: 'sec-2/a/2',
                  num: '(2)',
                  level: 3,
                  children: [],
                  pageStart: 1,
                  pageEnd: 1,
                  spans: [
                    {
                      text: 'The town shall provide a public planting calendar.',
                      status: 'unchanged',
                      page: 1,
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/** How a true amendment mark is drawn, relative to its text run. */
interface GeometryMark {
  status: 'deleted' | 'inserted';
  shape: 'line' | 'rect';
  /** Centre of the mark above the baseline, in ems of the body font size. */
  offsetEm: number;
  thickness: number;
}

interface GeometryRun {
  text: string;
  mark?: GeometryMark;
  /** Extra horizontal space after the run, in points (a wide gap between words). */
  gapAfter?: number;
}

interface GeometryLine {
  page: number;
  /** Ground-truth section this line's text belongs to. */
  section: string;
  runs: GeometryRun[];
  /** Draw the whole line with one text operator, so PDF.js returns one merged item. */
  merged?: boolean;
  /** The line is the section's heading, e.g. "Sec. 1.01. Definitions.": no body text. */
  heading?: string;
}

/** A drawn rule that is NOT an amendment mark; the parser must leave text unchanged. */
export interface PdfControl {
  name: string;
  page: number;
  /** The printed line it sits on or beside. */
  line: number;
  shape: 'line' | 'rect' | 'box';
  x: number;
  /** Line centre for lines; bottom edge for rects and boxes. */
  y: number;
  width: number;
  /** Stroke width for lines and boxes; height for rects. */
  thickness: number;
  /** Box height. */
  height?: number;
}

export interface PdfGeometryGroundTruth extends PdfGroundTruth {
  controls: PdfControl[];
}

const strike = (shape: 'line' | 'rect' = 'line', offsetEm = 0.4) => ({
  status: 'deleted' as const,
  shape,
  offsetEm,
  thickness: 0.6,
});
const underline = (
  shape: 'line' | 'rect' = 'line',
  offsetEm = -0.073,
  thickness = 0.6,
) => ({ status: 'inserted' as const, shape, offsetEm, thickness });

const SEC = 'sec-1.01';
/**
 * Every geometry case, one per printed line. Offsets: 0.4em is the generator's usual strike,
 * 0.26em is where Word and Courier New put strikeout (below a naive "middle third of the em"),
 * -0.257em is Ohio SB 113's underline and -0.133em Ohio SB 203's.
 */
const GEOMETRY_LINES: GeometryLine[] = [
  {
    page: 1,
    section: SEC,
    heading: 'Definitions',
    runs: [{ text: 'Sec. 1.01. Definitions.' }],
  },
  {
    page: 1,
    section: `${SEC}/A`,
    runs: [
      { text: '(A) A ' },
      { text: 'resident', mark: strike() },
      { text: ' ' },
      { text: 'domiciliary', mark: underline() },
      { text: ' shall file a return.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/B`,
    runs: [
      { text: '(B) The fee is ' },
      { text: 'ten', mark: strike('rect') },
      { text: ' ' },
      { text: 'twenty', mark: underline('rect', -0.09) },
      { text: ' dollars.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/C`,
    runs: [
      { text: '(C) The board ' },
      { text: 'may', mark: strike('line', 0.26) },
      { text: ' ' },
      { text: 'shall', mark: underline('line', -0.257, 0.5) },
      { text: ' adopt rules.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/D`,
    merged: true,
    runs: [
      { text: '(D) A notice shall be mailed ' },
      { text: 'by certified mail', mark: strike('line', 0.3) },
      { text: ' within ten days.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/E`,
    merged: true,
    runs: [
      { text: '(E) The agency' },
      { text: ',', mark: strike('line', 0.3) },
      { text: ' and the board' },
      { text: 's', mark: underline('line', -0.1) },
      { text: ' shall report.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/F`,
    runs: [
      { text: '(F) Records ' },
      // Ohio underlines run on over the trailing space.
      { text: 'requested by sheriffs ', mark: underline('line', -0.133, 0.7) },
      { text: 'pursuant to law.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/G`,
    runs: [
      { text: '(G) The department shall ' },
      { text: 'publish the annual', mark: underline() },
    ],
  },
  {
    page: 1,
    section: `${SEC}/G`,
    runs: [
      { text: 'report online', mark: underline() },
      { text: ' by March first.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/H`,
    runs: [{ text: '(H) Signed by the clerk:' }],
  },
  {
    page: 1,
    section: `${SEC}/I`,
    runs: [
      { text: '(I) Effective ', gapAfter: 57 },
      { text: 'upon enactment.' },
    ],
  },
  {
    page: 1,
    section: `${SEC}/J`,
    runs: [{ text: '(J) Fees are due annually.' }],
  },
  {
    page: 1,
    section: `${SEC}/K`,
    runs: [
      { text: '(K) The following language is ' },
      { text: 'repealed as of the', mark: strike() },
    ],
  },
  {
    page: 2,
    section: `${SEC}/K`,
    runs: [
      { text: 'effective date of this act', mark: strike() },
      { text: '.' },
    ],
  },
  {
    page: 2,
    section: 'sec-2',
    runs: [
      { text: 'Section 2. This act takes effect ninety days after passage.' },
    ],
  },
  {
    page: 2,
    section: 'sec-2',
    runs: [{ text: 'Table 1. Fee schedule' }],
  },
  // Struck headings and markers must never name a section: structure follows the kept text.
  {
    page: 2,
    section: 'sec-3',
    heading: 'Current rates.',
    runs: [
      { text: 'Section 3. ' },
      { text: 'Obsolete rates.', mark: strike() },
      { text: ' ' },
      { text: 'Current rates.', mark: underline() },
    ],
  },
  {
    page: 2,
    section: 'sec-3/A',
    runs: [
      { text: '(B)', mark: strike() },
      { text: ' (A) The rate is set by rule.' },
    ],
  },
  {
    page: 2,
    section: 'sec-3/A',
    runs: [{ text: 'Sec. 4. Repealed provisions.', mark: strike() }],
  },
];

function lineBaseline(line: number): number {
  return LAYOUT.firstLineY - (line - 1) * LAYOUT.lineSpacing;
}

function drawControl(page: PDFPage, control: PdfControl): void {
  if (control.shape === 'line') {
    page.drawLine({
      start: { x: control.x, y: control.y },
      end: { x: control.x + control.width, y: control.y },
      thickness: control.thickness,
      color: rgb(0, 0, 0),
    });
  } else if (control.shape === 'rect') {
    page.drawRectangle({
      x: control.x,
      y: control.y,
      width: control.width,
      height: control.thickness,
      color: rgb(0, 0, 0),
    });
  } else {
    page.drawRectangle({
      x: control.x,
      y: control.y,
      width: control.width,
      height: control.height ?? 0,
      borderWidth: control.thickness,
      borderColor: rgb(0, 0, 0),
    });
  }
}

/** Negative controls, placed from the drawn text so they stay correct if the text changes. */
function geometryControls(font: PDFFont): PdfControl[] {
  const size = LAYOUT.fontSize;
  const width = (text: string) => font.widthOfTextAtSize(text, size);
  const x = LAYOUT.textX;
  const clerk = width('(H) Signed by the clerk:');
  const effective = width('(I) Effective');
  const fees = width('(J) Fees are due annually.');
  return [
    {
      name: 'decorative bar thicker than a typographic rule, through text',
      page: 1,
      line: 1,
      shape: 'rect',
      x,
      y: lineBaseline(1) + 0.3 * size - 1.5,
      width: width('Sec. 1.01.'),
      thickness: 3,
    },
    {
      name: 'signature line beside its label, at underline height',
      page: 1,
      line: 10,
      shape: 'line',
      x: x + clerk + 6,
      y: lineBaseline(10) - 1,
      width: 144,
      thickness: 0.6,
    },
    {
      name: 'strike-height line through whitespace only',
      page: 1,
      line: 11,
      shape: 'line',
      x: x + effective + 3,
      y: lineBaseline(11) + 0.3 * size,
      width: 54,
      thickness: 0.6,
    },
    {
      name: 'strike-height line near the text but not overlapping it',
      page: 1,
      line: 12,
      shape: 'line',
      x: x + fees + 4,
      y: lineBaseline(12) + 0.3 * size,
      width: 60,
      thickness: 0.6,
    },
    {
      name: 'rule under the text, below the underline band',
      page: 1,
      line: 12,
      shape: 'line',
      x,
      y: lineBaseline(12) - 0.6 * size,
      width: fees,
      thickness: 0.6,
    },
    {
      name: 'table cell border hugging the text',
      page: 1,
      line: 12,
      shape: 'box',
      x: x - 2,
      y: lineBaseline(12) - 2,
      width: fees + 4,
      height: 11,
      thickness: 0.5,
    },
    {
      name: 'table rule between two lines',
      page: 1,
      line: 12,
      shape: 'line',
      x,
      y: lineBaseline(12) - LAYOUT.lineSpacing / 2,
      width: 468,
      thickness: 0.6,
    },
    {
      name: 'full-width table rule through text at strike height',
      page: 2,
      line: 3,
      shape: 'line',
      x: 54,
      y: lineBaseline(3) + 0.3 * size,
      width: 504,
      thickness: 0.6,
    },
  ];
}

/** Build the ground-truth tree from the line table; spans omit the printed marker. */
function geometrySections(): Section[] {
  const perPage = new Map<number, number>();
  const nodes = new Map<string, Section>();
  const roots: Section[] = [];
  for (const line of GEOMETRY_LINES) {
    const number = (perPage.get(line.page) ?? 0) + 1;
    perPage.set(line.page, number);
    let node = nodes.get(line.section);
    const opens = !node;
    if (!node) {
      const division = /\/([A-Z])$/.exec(line.section)?.[1];
      const parent = nodes.get(line.section.replace(/\/[A-Z]$/, ''));
      node = {
        id: line.section,
        num: division ? `(${division})` : line.section.slice('sec-'.length),
        level: parent ? parent.level + 1 : 1,
        spans: [],
        children: [],
        pageStart: line.page,
        lineStart: number,
      };
      nodes.set(line.section, node);
      (parent?.children ?? roots).push(node);
    }
    if (line.heading) node.heading = line.heading;
    // Parent ranges include their descendants.
    for (const id of [line.section, line.section.replace(/\/[A-Z]$/, '')]) {
      const covering = nodes.get(id)!;
      covering.pageEnd = line.page;
      covering.lineEnd = number;
    }
    line.runs.forEach((run, index) => {
      // Spans hold body text, as in the other samples: drop the opening line's marker.
      const text =
        opens && index === 0
          ? run.text.replace(/^(?:\([A-Z]\)|Section \d+\.|Sec\. [\d.]+\.) /, '')
          : run.text;
      if (text)
        node.spans.push(
          span(text, line.page, number, run.mark?.status ?? 'unchanged'),
        );
    });
  }
  return roots;
}

/**
 * Every amendment-geometry case on two numbered pages (numbers restart on page 2): strikes and
 * underlines drawn as lines and as thin filled rects, at the generator's, Word's and Ohio's
 * offsets; marks inside one merged text run, including single-character marks; an underline
 * that runs on over a trailing space; insertions and deletions that wrap across a line and
 * across the page break; and negative controls that must not mark anything.
 */
export async function makeAmendmentGeometryPdf(): Promise<
  SyntheticSample<PdfGeometryGroundTruth>
> {
  const doc = await newDocument();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const size = LAYOUT.fontSize;
  const decorations: PdfDecoration[] = [];
  const pages = [1, 2].map((pageNumber) => {
    const page = doc.addPage([LAYOUT.pageWidth, LAYOUT.pageHeight]);
    page.drawText('As Introduced', { x: 250, y: 754, size: 10, font });
    page.drawText(String(pageNumber), { x: 302, y: 30, size: 10, font });
    return page;
  });
  const truthPages: PdfGroundTruth['pages'] = [1, 2].map((page) => ({
    page,
    lines: {},
    header: 'As Introduced',
    footer: String(page),
  }));
  const counters = new Map<number, number>();
  for (const spec of GEOMETRY_LINES) {
    const page = pages[spec.page - 1]!;
    const line = (counters.get(spec.page) ?? 0) + 1;
    counters.set(spec.page, line);
    const y = lineBaseline(line);
    const full = spec.runs.map((run) => run.text).join('');
    truthPages[spec.page - 1]!.lines[line] = full;
    page.drawText(String(line), { x: LAYOUT.lineNumberX, y, font, size: 8 });
    if (spec.merged) page.drawText(full, { x: LAYOUT.textX, y, font, size });
    let x = LAYOUT.textX;
    for (const run of spec.runs) {
      const width = font.widthOfTextAtSize(run.text, size);
      if (!spec.merged) {
        // Marked-content boundaries keep PDF.js from merging runs; they carry no status.
        if (run.mark) page.pushOperators(beginMarkedContent('Span'));
        page.drawText(run.text, { x, y, font, size });
        if (run.mark) page.pushOperators(endMarkedContent());
      }
      if (run.mark) {
        const centre = y + run.mark.offsetEm * size;
        const mark: PdfDecoration = {
          text: run.text,
          status: run.mark.status,
          shape: run.mark.shape,
          page: spec.page,
          line,
          x,
          width,
          thickness: run.mark.thickness,
          y:
            run.mark.shape === 'rect'
              ? centre - run.mark.thickness / 2
              : centre,
        };
        drawDecoration(page, mark);
        decorations.push(mark);
      }
      x += width + (run.gapAfter ?? 0);
    }
  }
  const controls = geometryControls(font);
  for (const control of controls)
    drawControl(pages[control.page - 1]!, control);
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    groundTruth: {
      layout: { ...LAYOUT },
      pages: truthPages,
      sections: geometrySections(),
      expectedSectionNumbers: ['1.01', '2', '3'],
      decorations,
      controls,
      deletedStrings: [
        'resident',
        'ten',
        'may',
        'by certified mail',
        ',',
        'repealed as of the',
        'effective date of this act',
        'Obsolete rates.',
        '(B)',
        'Sec. 4. Repealed provisions.',
      ],
      insertedStrings: [
        'domiciliary',
        'twenty',
        'shall',
        's',
        'requested by sheriffs',
        'publish the annual',
        'report online',
        'Current rates.',
      ],
    },
  };
}
