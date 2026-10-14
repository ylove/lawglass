import { createHash } from 'node:crypto';
import {
  degrees,
  PDFDocument,
  PDFString,
  rgb,
  StandardFonts,
  type PDFPage,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  makeAmendingBillPdf,
  makeAmendmentGeometryPdf,
  makeFederalStylePdf,
  makeScannedPdf,
  SCAN_PIXEL,
} from '../../../tests/synth/index.js';
import { chunkDocument } from '../chunk/index.js';
import {
  AppError,
  EMPTY_METADATA,
  ERROR_CODES,
  NormalizedDoc,
  sectionText,
  walkSections,
  type Section,
  type Span,
  type SpanStatus,
} from '../model/index.js';
import { parsePdf } from './index.js';
import type { StyledLine } from './pdf-lines.js';
import { toSourceLines, withoutCanvasNotices } from './pdf.js';

const options = {
  sourceUrl: 'https://example.gov/bill.pdf',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Body text long enough that its page is clearly not a scan. */
const BODY = 'Section 1. The board shall adopt rules for the program by June.';

/** Paint a page-sized image, as a scanner would. */
async function scanned(pdf: PDFDocument, page: PDFPage): Promise<void> {
  const image = await pdf.embedPng(SCAN_PIXEL);
  page.drawImage(image, { x: 0, y: 0, width: 612, height: 792 });
}
const byStatus = (spans: readonly Span[], status: SpanStatus): string[] =>
  spans
    .filter((span) => span.status === status)
    .map((span) => normalize(span.text));
/** Ground-truth text: spans on one printed line abut; printed lines are separated by a space. */
function expectedText(section: Section, includeDeleted: boolean): string {
  let text = '';
  let previous: Span | undefined;
  for (const span of section.spans) {
    if (
      previous &&
      (previous.page !== span.page || previous.line !== span.line)
    )
      text += ' ';
    if (includeDeleted || span.status !== 'deleted') text += span.text;
    previous = span;
  }
  return normalize(text);
}
const allSpans = (sections: readonly Section[]): Span[] =>
  [...walkSections(sections)].flatMap((section) => section.spans);
const byId = (sections: readonly Section[]): Map<string, Section> =>
  new Map([...walkSections(sections)].map((section) => [section.id, section]));

async function rejection(promise: Promise<unknown>): Promise<AppError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(AppError);
  return error as AppError;
}

describe('parsePdf on the synthetic amending bill', () => {
  it.each([2, 3])(
    'matches the ground truth for %i pages: sections, coordinates and amendments',
    async (pageCount) => {
      const { bytes, groundTruth } = await makeAmendingBillPdf({ pageCount });
      const original = bytes.slice();
      const doc = await parsePdf(bytes, options);
      expect(NormalizedDoc.safeParse(doc).success).toBe(true);
      expect(doc).toMatchObject({
        docId: createHash('sha256').update(original).digest('hex'),
        ...options,
        format: 'pdf',
        metadata: EMPTY_METADATA,
        definitions: [],
        externalRefs: [],
        warnings: [],
        pageCount,
      });
      // The caller's buffer is hashed and left intact (PDF.js gets a copy).
      expect(bytes).toEqual(original);
      expect(
        doc.sections.filter((s) => s.id !== 'preamble').map((s) => s.num),
      ).toEqual(groundTruth.expectedSectionNumbers);

      const parsed = byId(doc.sections);
      for (const expected of walkSections(groundTruth.sections)) {
        const actual = parsed.get(expected.id.toLowerCase());
        expect(actual, expected.id).toBeDefined();
        expect(actual).toMatchObject({
          num: expected.num,
          level: expected.level,
          pageStart: expected.pageStart,
          pageEnd: expected.pageEnd,
          lineStart: expected.lineStart,
          lineEnd: expected.lineEnd,
        });
        expect(
          normalize(sectionText(actual!, { includeDeleted: true })),
        ).toContain(expectedText(expected, true));
        for (const status of ['deleted', 'inserted'] as const)
          expect(byStatus(actual!.spans, status)).toEqual(
            byStatus(expected.spans, status),
          );
      }
      const spans = allSpans(doc.sections);
      expect(byStatus(spans, 'deleted')).toEqual(groundTruth.deletedStrings);
      expect(byStatus(spans, 'inserted')).toEqual(groundTruth.insertedStrings);
    },
  );

  it('drops running headers, page numbers and line numbers, and keeps the title', async () => {
    const { bytes } = await makeAmendingBillPdf();
    const doc = await parsePdf(bytes, options);
    expect(sectionText(doc.sections[0]!, { includeDeleted: true })).toBe(
      'SYNTHETIC GENERAL ASSEMBLY\nH. B. No. 9001 - Community Garden Credits\n',
    );
    const text = allSpans(doc.sections)
      .map((span) => span.text)
      .join('');
    expect(text).not.toContain('As Introduced');
    expect(text).not.toMatch(/^\d+\s/m);
    for (const span of allSpans(doc.sections).slice(2)) {
      expect(span.page).toBeGreaterThan(0);
      expect(span.line).toBeGreaterThan(0);
    }
  });

  it('accepts a Node Buffer and leaves it intact', async () => {
    const { bytes } = await makeAmendingBillPdf();
    const buffer = Buffer.from(bytes);
    const doc = await parsePdf(buffer, options);
    expect(doc.docId).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(buffer.equals(Buffer.from(bytes))).toBe(true);
  });

  it('is deterministic', async () => {
    const { bytes } = await makeAmendingBillPdf();
    expect(await parsePdf(bytes, options)).toEqual(
      await parsePdf(bytes, options),
    );
  });
});

describe('parsePdf on every amendment-geometry case', async () => {
  const { bytes, groundTruth } = await makeAmendmentGeometryPdf();
  const doc = await parsePdf(bytes, options);
  const spans = allSpans(doc.sections);
  const onLine = (page: number, line: number) =>
    spans.filter((span) => span.page === page && span.line === line);

  it('builds the expected tree, flagging only the heavy decorative bar', () => {
    expect([...walkSections(doc.sections)].map((s) => s.id)).toEqual([
      ...[...walkSections(groundTruth.sections)].map((s) => s.id.toLowerCase()),
    ]);
    // The 3pt bar through line 1 is a negative control: unmarked, but worth a look.
    expect(doc.warnings).toEqual([
      'Page 1, line 1: a rule through or under the text is too heavy to be a strikethrough or underline (perhaps a bar or highlight), so that text is treated as unchanged; check it.',
    ]);
    expect(doc.pageCount).toBe(2);
  });

  it.each(
    groundTruth.decorations.map((mark) => [
      `${mark.status} ${mark.shape} "${mark.text.trim()}" (p${String(mark.page)} l${String(mark.line)})`,
      mark,
    ]),
  )('marks %s', (_, mark) => {
    const matching = onLine(mark.page, mark.line).filter(
      (span) => span.status === mark.status,
    );
    expect(matching.map((span) => normalize(span.text))).toContain(
      mark.text.trim(),
    );
  });

  it.each(groundTruth.controls.map((control) => [control.name, control]))(
    'ignores a negative control: %s',
    (_, control) => {
      const line = onLine(control.page, control.line);
      expect(line.length).toBeGreaterThan(0);
      for (const span of line) expect(span.status).toBe('unchanged');
    },
  );

  it('lists exactly the struck and underlined strings, in reading order', () => {
    expect(byStatus(spans, 'deleted')).toEqual(groundTruth.deletedStrings);
    expect(byStatus(spans, 'inserted')).toEqual(groundTruth.insertedStrings);
  });

  it('keeps each section text, location and amendment runs', () => {
    const parsed = byId(doc.sections);
    for (const expected of walkSections(groundTruth.sections)) {
      const actual = parsed.get(expected.id.toLowerCase())!;
      expect(actual, expected.id).toMatchObject({
        num: expected.num,
        pageStart: expected.pageStart,
        pageEnd: expected.pageEnd,
        lineStart: expected.lineStart,
        lineEnd: expected.lineEnd,
      });
      expect(
        normalize(sectionText(actual, { includeDeleted: true })),
      ).toContain(expectedText(expected, true));
      expect(
        normalize(sectionText(actual, { includeDeleted: false })),
      ).toContain(expectedText(expected, false));
    }
  });

  it('follows a deletion across the page break, where line numbers restart', () => {
    const division = byId(doc.sections).get('sec-1.01/k')!;
    expect(division).toMatchObject({
      pageStart: 1,
      lineStart: 13,
      pageEnd: 2,
      lineEnd: 1,
    });
    expect(
      division.spans
        .filter((span) => span.status === 'deleted')
        .map(({ text, page, line }) => [normalize(text), page, line]),
    ).toEqual([
      ['repealed as of the', 1, 13],
      ['effective date of this act', 2, 1],
    ]);
    expect(sectionText(division, { includeDeleted: false })).toBe(
      '(K) The following language is .\n',
    );
  });

  it('names sections only from text that is not struck', () => {
    const sections = byId(doc.sections);
    expect(sections.get('sec-3')?.heading).toBe('Current rates.');
    expect(sections.get('sec-3/a')?.num).toBe('(A)');
    expect(sections.has('sec-4')).toBe(false);
    for (const section of walkSections([sections.get('sec-3')!])) {
      for (const field of [section.heading, section.num])
        expect(field ?? '').not.toMatch(/Obsolete|Repealed|^\(B\)$/);
    }
  });

  it('never lets struck text reach a non-deleted chunk heading, breadcrumb or embedding', () => {
    const kept = allSpans(doc.sections)
      .filter((span) => span.status !== 'deleted')
      .map((span) => span.text)
      .join(' ');
    // Struck strings that also occur as kept text ("ten", ",") cannot be told apart.
    const distinctive = groundTruth.deletedStrings.filter(
      (text) => text.length > 3 && !kept.includes(text),
    );
    expect(distinctive).toEqual(
      expect.arrayContaining([
        'Obsolete rates.',
        'Sec. 4. Repealed provisions.',
      ]),
    );
    const chunks = chunkDocument(doc);
    expect(chunks.some((chunk) => chunk.amendmentStatus === 'deleted')).toBe(
      true,
    );
    for (const chunk of chunks.filter((c) => c.amendmentStatus !== 'deleted')) {
      for (const text of distinctive) {
        expect(chunk.heading ?? '').not.toContain(text);
        expect(chunk.breadcrumb).not.toContain(text);
        expect(chunk.embedText).not.toContain(text);
      }
    }
  });
});

describe('parsePdf on other layouts', () => {
  it('reads a federal-style bill without line numbers, and says so', async () => {
    const { bytes, groundTruth } = await makeFederalStylePdf();
    const doc = await parsePdf(bytes, options);
    expect(doc.warnings).toEqual([
      'Line numbers were not found in this PDF; citations use page numbers only.',
    ]);
    const parsed = byId(doc.sections);
    for (const expected of walkSections(groundTruth.sections)) {
      const actual = parsed.get(expected.id)!;
      expect(actual, expected.id).toMatchObject({
        num: expected.num,
        pageStart: 1,
        pageEnd: 1,
      });
      expect(actual).not.toHaveProperty('lineStart');
      expect(
        normalize(sectionText(actual, { includeDeleted: true })),
      ).toContain(expectedText(expected, true));
    }
    for (const span of allSpans(doc.sections)) {
      expect(span).toMatchObject({ page: 1, status: 'unchanged' });
      expect(span).not.toHaveProperty('line');
    }
  });

  it('rejects a PDF without a text layer with the OCR message from the spec', async () => {
    const { bytes } = await makeScannedPdf();
    const error = await rejection(parsePdf(bytes, options));
    expect(error.code).toBe('SCANNED_PDF');
    expect(error.userMessage).toBe(
      "This PDF appears to be scanned; OCR isn't supported yet.",
    );
    expect(error.userMessage).toBe(ERROR_CODES.SCANNED_PDF);
  });

  it('treats page images with only a stray stamp of text as scanned', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    for (const number of ['1', '2']) {
      const page = pdf.addPage();
      await scanned(pdf, page);
      page.drawText(number, { x: 300, y: 30, size: 10, font });
    }
    const error = await rejection(parsePdf(await pdf.save(), options));
    expect(error.code).toBe('SCANNED_PDF');
  });

  it('reads a short text-only PDF rather than calling it scanned (review finding 4)', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText('Section 1.', { x: 72, y: 700, size: 11, font });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.sections.map((section) => section.id)).toEqual(['sec-1']);
    expect(doc.warnings.join('\n')).not.toMatch(/text layer/);
  });

  it('does not call a short cover page scanned', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText('HB 5', { x: 250, y: 600, size: 30, font });
    pdf.addPage().drawText(BODY, { x: 72, y: 700, size: 11, font });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.warnings.join('\n')).not.toMatch(/text layer/);
  });

  it('reports a PDF with no text and no images as unreadable, not scanned', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage().drawRectangle({ x: 72, y: 600, width: 300, height: 8 });
    const error = await rejection(parsePdf(await pdf.save(), options));
    expect(error).toMatchObject({
      code: 'PARSE_FAILED',
      message: 'The PDF contains no text.',
    });
  });

  it('keeps the text pages of a partly scanned PDF and warns about the rest', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText(BODY, { x: 72, y: 700, size: 11, font });
    await scanned(pdf, pdf.addPage());
    // A blank page is neither text nor a scan, so it gets no warning.
    pdf.addPage().drawRectangle({
      x: 72,
      y: 600,
      width: 300,
      height: 8,
      color: rgb(0.2, 0.2, 0.2),
    });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.pageCount).toBe(3);
    expect(doc.sections.map((section) => section.id)).toEqual(['sec-1']);
    expect(doc.warnings.filter((w) => w.includes('text layer'))).toEqual([
      'Page 2 has no text layer (it may be a scanned image), so its content is missing.',
    ]);
  });

  it('skips rotated text such as a margin stamp, with a warning', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const page = pdf.addPage();
    page.drawText('Section 1. Upright body text.', {
      x: 72,
      y: 700,
      size: 11,
      font,
    });
    page.drawText('RECEIVED BY THE CLERK', {
      x: 560,
      y: 300,
      size: 9,
      font,
      rotate: degrees(90),
    });
    const doc = await parsePdf(await pdf.save(), options);
    expect(
      allSpans(doc.sections)
        .map((span) => span.text)
        .join(''),
    ).toBe('Section 1. Upright body text.');
    expect(doc.warnings).toContain(
      'Page 1: rotated text (such as a stamp) was skipped.',
    );
  });
});

describe('review findings, end to end', () => {
  const statusesOf = async (bytes: Uint8Array) => {
    const doc = await parsePdf(bytes, options);
    return {
      doc,
      runs: allSpans(doc.sections).map((span) => [
        span.status,
        normalize(span.text),
      ]),
    };
  };

  /** One Courier line (0.6em per character), plus whatever `draw` adds. */
  async function courierLine(
    text: string,
    size: number,
    draw: (page: PDFPage, charWidth: number, pdf: PDFDocument) => void,
  ): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Courier);
    const page = pdf.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 600, size, font });
    draw(page, 0.6 * size, pdf);
    return pdf.save();
  }

  it('reads a 3pt strike through 48pt text as struck (finding 1)', async () => {
    const bytes = await courierLine('Sec. 1. Big word.', 48, (page, w) => {
      page.drawLine({
        start: { x: 72 + 12 * w, y: 600 + 0.3 * 48 },
        end: { x: 72 + 16 * w, y: 600 + 0.3 * 48 },
        thickness: 3,
      });
    });
    const { runs, doc } = await statusesOf(bytes);
    expect(runs).toContainEqual(['deleted', 'word']);
    expect(doc.warnings.join('\n')).not.toMatch(/too heavy/);
  });

  it('reads a filled and stroked 1.6pt bar through 12pt text as struck (finding 1)', async () => {
    const bytes = await courierLine(
      'Sec. 1. The quick brown fox.',
      12,
      (page, w) => {
        page.drawRectangle({
          x: 72 + 18 * w,
          y: 600 + 0.3 * 12 - 0.3,
          width: 5 * w,
          height: 0.6,
          color: rgb(0, 0, 0),
          borderColor: rgb(0, 0, 0),
          borderWidth: 1,
        });
      },
    );
    expect((await statusesOf(bytes)).runs).toContainEqual(['deleted', 'brown']);
  });

  it('warns instead of silently dropping a strike too heavy to trust (finding 1)', async () => {
    const bytes = await courierLine(
      'Sec. 1. The quick brown fox.',
      10,
      (page, w) => {
        page.drawLine({
          start: { x: 72 + 18 * w, y: 603 },
          end: { x: 72 + 23 * w, y: 603 },
          thickness: 3,
        });
      },
    );
    const { runs, doc } = await statusesOf(bytes);
    expect(runs.every(([status]) => status === 'unchanged')).toBe(true);
    expect(doc.warnings.join('\n')).toMatch(/too heavy to be a strikethrough/);
  });

  it('ignores a white cover-up rectangle (finding 2)', async () => {
    const bytes = await courierLine(
      'Sec. 1. The quick brown fox.',
      12,
      (page, w) => {
        page.drawRectangle({
          x: 72 + 18 * w,
          y: 603.3,
          width: 5 * w,
          height: 0.6,
          color: rgb(1, 1, 1),
        });
      },
    );
    const { runs, doc } = await statusesOf(bytes);
    expect(runs.every(([status]) => status === 'unchanged')).toBe(true);
    expect(doc.warnings.join('\n')).not.toMatch(/rule/);
  });

  it('does not mark a whole line under a hairline grid rule, and says why (finding 2)', async () => {
    const text = 'Sec. 1. The quick brown fox.';
    const bytes = await courierLine(text, 12, (page, w) => {
      page.drawLine({
        start: { x: 72, y: 603.6 },
        end: { x: 72 + text.length * w, y: 603.6 },
        thickness: 0.1,
      });
    });
    const { runs, doc } = await statusesOf(bytes);
    expect(runs.every(([status]) => status === 'unchanged')).toBe(true);
    expect(doc.warnings.join('\n')).toMatch(/hairline rule crosses the text/);
  });

  it('does not read a hyperlink underline as an insertion, but keeps a strike in a link (finding 3)', async () => {
    const bytes = await courierLine(
      'Sec. 1. See the board site now.',
      12,
      (page, w, pdf) => {
        const link = (from: number, to: number) => {
          page.node.addAnnot(
            pdf.context.register(
              pdf.context.obj({
                Type: 'Annot',
                Subtype: 'Link',
                Rect: [72 + from * w, 598, 72 + to * w, 610],
                Border: [0, 0, 0],
                A: { S: 'URI', URI: PDFString.of('https://example.gov') },
              }),
            ),
          );
        };
        link(16, 26);
        page.drawLine({
          start: { x: 72 + 16 * w, y: 598.5 },
          end: { x: 72 + 26 * w, y: 598.5 },
          thickness: 0.5,
          color: rgb(0, 0, 1),
        });
        link(4, 7);
        page.drawLine({
          start: { x: 72 + 4 * w, y: 603.1 },
          end: { x: 72 + 7 * w, y: 603.1 },
          thickness: 0.6,
        });
      },
    );
    const { runs } = await statusesOf(bytes);
    expect(runs.filter(([status]) => status === 'inserted')).toEqual([]);
    expect(runs).toContainEqual(['deleted', '1.']);
  });

  it('reads fake-bold overprinted text once (finding 6)', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const page = pdf.addPage();
    for (const dx of [0, 0.3])
      page.drawText(BODY, { x: 72 + dx, y: 700, size: 11, font });
    const doc = await parsePdf(await pdf.save(), options);
    expect(
      allSpans(doc.sections)
        .map((span) => span.text)
        .join(''),
    ).toBe(BODY);
  });

  it('warns that a two-column page is read straight across (finding 5)', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const page = pdf.addPage();
    [0, 1, 2, 3].forEach((row) => {
      page.drawText('Section 1. The quick brown fox', {
        x: 72,
        y: 700 - row * 14,
        size: 11,
        font,
      });
      page.drawText('Section 2. Another brown thing', {
        x: 330,
        y: 700 - row * 14,
        size: 11,
        font,
      });
    });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.warnings).toContain(
      'Page 1 looks like it has two columns (or a table); its lines are read straight across, so text there may be out of order.',
    );
  });

  it('gives a fully rotated page only the rotated-text warning (finding 4)', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf
      .addPage()
      .drawText(BODY, { x: 300, y: 100, size: 11, font, rotate: degrees(90) });
    pdf.addPage().drawText(BODY, { x: 72, y: 700, size: 11, font });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.warnings).toContain(
      'Page 1: rotated text (such as a stamp) was skipped.',
    );
    expect(doc.warnings.join('\n')).not.toMatch(/text layer/);
  });
});

describe('withoutCanvasNotices', () => {
  it('drops only PDF.js canvas notices while loading, and restores console.warn', async () => {
    const seen: unknown[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      seen.push(args[0]);
    };
    try {
      const result = await withoutCanvasNotices(() => {
        console.warn('Warning: Cannot load "@napi-rs/canvas" package: "Error"');
        console.warn(
          'Warning: Cannot polyfill `DOMMatrix`, rendering may be broken.',
        );
        console.warn(
          'Warning: Cannot polyfill `Path2D`, rendering may be broken.',
        );
        console.warn('Warning: something else');
        console.warn(42);
        return Promise.resolve('loaded');
      });
      expect(result).toBe('loaded');
      await expect(
        withoutCanvasNotices(() => Promise.reject(new Error('boom'))),
      ).rejects.toThrow('boom');
      console.warn('after');
    } finally {
      console.warn = original;
    }
    expect(seen).toEqual(['Warning: something else', 42, 'after']);
  });
});

describe('parsePdf input errors', () => {
  it.each([
    { sourceUrl: 'not a url', fetchedAt: options.fetchedAt },
    { sourceUrl: options.sourceUrl, fetchedAt: 'yesterday' },
  ])('rejects invalid options %j before reading the PDF', async (bad) => {
    const error = await rejection(parsePdf(new Uint8Array(), bad));
    expect(error.code).toBe('INVALID_INPUT');
  });

  it('reports bytes that are not a PDF as unreadable', async () => {
    const error = await rejection(
      parsePdf(new TextEncoder().encode('not a pdf at all'), options),
    );
    expect(error).toMatchObject({
      code: 'PARSE_FAILED',
      message: 'The PDF could not be opened.',
      userMessage: ERROR_CODES.PARSE_FAILED,
    });
  });

  it('reports a password-protected PDF as unreadable, saying why', async () => {
    const hex = (bytes: number) => 'ab'.repeat(bytes);
    const encrypted = [
      '%PDF-1.4',
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj',
      `3 0 obj << /Filter /Standard /V 1 /R 2 /O <${hex(32)}> /U <${hex(32)}> /P -44 >> endobj`,
      `trailer << /Root 1 0 R /Encrypt 3 0 R /ID [<${hex(16)}> <${hex(16)}>] >>`,
      '%%EOF',
    ].join('\n');
    const error = await rejection(
      parsePdf(new TextEncoder().encode(encrypted), options),
    );
    expect(error).toMatchObject({
      code: 'PARSE_FAILED',
      message: 'The PDF is password-protected.',
    });
  });
});

describe('toSourceLines', () => {
  const line = (
    text: string,
    x: number,
    extra: Partial<StyledLine> = {},
  ): StyledLine => ({
    page: 1,
    x,
    text,
    statuses: Array.from(text, () => 'unchanged'),
    ...extra,
  });

  it('flags margin lines as continuations in a first-line-indent layout, and drops a uniform indent', () => {
    const source = toSourceLines([
      line('Sec. 1. (A) The board shall act under division', 111, { line: 1 }),
      line('(B) of this section within ninety days.', 75, { line: 2 }),
      line('(B) The board shall report.', 111, { line: 3 }),
      line('(1) Each report is public.', 111),
      line('wrapped text', 75),
    ]);
    expect(source.map((s) => s.continuation ?? false)).toEqual([
      false,
      true,
      false,
      false,
      true,
    ]);
    expect(source.every((s) => s.x === undefined)).toBe(true);
    expect(source[0]).toMatchObject({ page: 1, line: 1 });
    expect(source[3]).not.toHaveProperty('line');
  });

  it('passes indentation through when heading indents differ by level', () => {
    const source = toSourceLines([
      line('SEC. 2. GRANTS.', 72),
      line('(a) Eligibility.', 90),
      line('(1) A town may apply.', 108),
      line('wrapped', 72),
      line('wrapped', 72),
      line('wrapped', 72),
    ]);
    expect(source.map((s) => s.x)).toEqual([72, 90, 108, 72, 72, 72]);
    expect(source.some((s) => s.continuation)).toBe(false);
  });

  it('flags nothing in a flush-left layout and honours custom patterns', () => {
    const flush = [
      line('Sec. 1. A.', 72),
      line('(a) B.', 72),
      line('text', 72),
    ];
    expect(
      toSourceLines(flush).some(
        (s) => s.continuation !== undefined || s.x !== undefined,
      ),
    ).toBe(false);
    const custom = toSourceLines(
      [
        line('Rule 1 applies.', 90),
        line('Rule 2 too.', 72),
        line('text', 72),
        line('text', 72),
      ],
      [{ kind: 'section', regex: /^Rule (\d+)/ }],
    );
    expect(custom.map((s) => s.continuation ?? false)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });
});
