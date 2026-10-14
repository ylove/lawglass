import { createHash } from 'node:crypto';
import { degrees, PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  makeAmendingBillPdf,
  makeAmendmentGeometryPdf,
  makeFederalStylePdf,
  makeScannedPdf,
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
import { toSourceLines } from './pdf.js';

const options = {
  sourceUrl: 'https://example.gov/bill.pdf',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
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

  it('builds the expected tree with no warnings', () => {
    expect([...walkSections(doc.sections)].map((s) => s.id)).toEqual([
      ...[...walkSections(groundTruth.sections)].map((s) => s.id.toLowerCase()),
    ]);
    expect(doc.warnings).toEqual([]);
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

  it('treats a page with only a stray page number as textless', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText('1', { x: 300, y: 30, size: 10, font });
    const error = await rejection(parsePdf(await pdf.save(), options));
    expect(error.code).toBe('SCANNED_PDF');
  });

  it('keeps the text pages of a partly scanned PDF and warns about the rest', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText('Section 1. A typed page of the bill.', {
      x: 72,
      y: 700,
      size: 11,
      font,
    });
    pdf.addPage().drawRectangle({
      x: 72,
      y: 600,
      width: 300,
      height: 8,
      color: rgb(0.2, 0.2, 0.2),
    });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.pageCount).toBe(2);
    expect(doc.sections.map((section) => section.id)).toEqual(['sec-1']);
    expect(doc.warnings).toContain(
      'Page 2 has no text layer (it may be a scanned image), so its content is missing.',
    );
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
