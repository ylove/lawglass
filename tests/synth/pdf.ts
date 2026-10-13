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
