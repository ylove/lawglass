import { describe, expect, it } from 'vitest';
import {
  getDocument,
  OPS,
  PDFWorker,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import { z } from 'zod';
import { Section, walkSections } from '../../src/core/model/index.js';
import {
  makeAmendingBillPdf,
  makeAmendmentGeometryPdf,
  makeFederalStylePdf,
  makeScannedPdf,
} from './pdf.js';

type TextItem = Extract<
  Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number],
  { str: string }
>;

async function withPdf(
  bytes: Uint8Array,
  check: (doc: PDFDocumentProxy) => Promise<void>,
): Promise<void> {
  // Node's legacy build disables web workers and runs its fake worker on this thread.
  // Copy bytes because PDF.js may take ownership of (and detach) the supplied buffer.
  const worker = new PDFWorker();
  const task = getDocument({
    data: bytes.slice(),
    worker,
    useSystemFonts: true,
  });
  try {
    await check(await task.promise);
  } finally {
    await task.destroy();
    worker.destroy();
  }
}

async function textItems(
  doc: PDFDocumentProxy,
  page: number,
): Promise<TextItem[]> {
  const content = await (await doc.getPage(page)).getTextContent();
  return content.items.filter(
    (item): item is TextItem => 'str' in item && item.str !== '',
  );
}

// PDF.js declares transforms as any[]; validate at the test's reader boundary.
const transform = z.tuple([
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
  z.number(),
]);
const position = (item: TextItem) => {
  const matrix = transform.parse(item.transform);
  return { x: matrix[4], y: matrix[5] };
};

describe('amending PDF reader round-trip', () => {
  it.each([2, 3])(
    'extracts every numbered body line and running furniture from %i pages',
    async (pageCount) => {
      const { bytes, groundTruth } = await makeAmendingBillPdf({ pageCount });
      expect(groundTruth.sections.map((s) => s.num)).toEqual(
        groundTruth.expectedSectionNumbers,
      );
      groundTruth.sections.forEach((section) => Section.parse(section));
      await withPdf(bytes, async (doc) => {
        expect(doc.numPages).toBe(pageCount);
        expect((await doc.getMetadata()).info).toMatchObject({
          CreationDate: 'D:20260101000000Z',
          ModDate: 'D:20260101000000Z',
        });
        for (const page of groundTruth.pages) {
          const items = await textItems(doc, page.page);
          expect(
            items.some(
              (item) => item.str === page.header && position(item).y === 754,
            ),
          ).toBe(true);
          expect(
            items.some(
              (item) => item.str === page.footer && position(item).y === 30,
            ),
          ).toBe(true);
          for (const [line, expectedText] of Object.entries(page.lines)) {
            const y =
              groundTruth.layout.firstLineY -
              (Number(line) - 1) * groundTruth.layout.lineSpacing;
            const row = items.filter((item) => position(item).y === y);
            const number = row.filter(
              (item) => position(item).x === groundTruth.layout.lineNumberX,
            );
            expect(number.map((item) => item.str)).toEqual([line]);
            expect(
              row
                .filter((item) => position(item).x >= groundTruth.layout.textX)
                .map((item) => item.str)
                .join(''),
            ).toBe(expectedText);
          }
          for (const section of walkSections(groundTruth.sections)) {
            for (const span of section.spans.filter(
              (span) => span.page === page.page,
            )) {
              const lineText = page.lines[span.line!];
              expect(lineText).toContain(span.text.trim());
            }
          }
        }
      });
    },
  );

  it('keeps both deleted and inserted strings searchable, with line and rectangle drawing operators', async () => {
    const { bytes, groundTruth } = await makeAmendingBillPdf();
    await withPdf(bytes, async (doc) => {
      const items = await textItems(doc, 1);
      const text = items.map((item) => item.str).join('');
      for (const phrase of [
        ...groundTruth.deletedStrings,
        ...groundTruth.insertedStrings,
      ])
        expect(text).toContain(phrase);
      const operators = await (await doc.getPage(1)).getOperatorList();
      const paths = operators.fnArray.flatMap((fn, i) =>
        fn === OPS.constructPath
          ? [z.array(z.unknown()).parse(operators.argsArray[i])]
          : [],
      );
      expect(paths.filter((args) => args[0] === OPS.stroke)).toHaveLength(2);
      expect(paths.filter((args) => args[0] === OPS.fill)).toHaveLength(2);
      // Generated drawing transforms are translations only. Read the actual path
      // bounds so misplaced or missing marks cannot pass on text extraction alone.
      let state = { x: 0, y: 0, lineWidth: 1 };
      const stack: (typeof state)[] = [];
      const drawings: {
        shape: string;
        x: number;
        y: number;
        width: number;
        thickness: number;
      }[] = [];
      operators.fnArray.forEach((fn, index) => {
        const args = z
          .array(z.unknown())
          .parse(operators.argsArray[index] ?? []);
        if (fn === OPS.save) stack.push({ ...state });
        else if (fn === OPS.restore) state = stack.pop()!;
        else if (fn === OPS.setLineWidth)
          state.lineWidth = z.number().parse(args[0]);
        else if (fn === OPS.transform) {
          const matrix = transform.parse(args);
          expect(matrix.slice(0, 4)).toEqual([1, 0, 0, 1]);
          state.x += matrix[4];
          state.y += matrix[5];
        } else if (fn === OPS.constructPath) {
          const bounds = z.instanceof(Float32Array).parse(args[2]);
          expect(bounds).toHaveLength(4);
          drawings.push({
            shape: args[0] === OPS.stroke ? 'line' : 'rect',
            x: bounds[0]! + state.x,
            y: bounds[1]! + state.y,
            width: bounds[2]! - bounds[0]!,
            thickness:
              args[0] === OPS.stroke
                ? state.lineWidth
                : bounds[3]! - bounds[1]!,
          });
        }
      });
      expect(drawings).toHaveLength(groundTruth.decorations.length);
      drawings.forEach((drawing, index) => {
        const expected = groundTruth.decorations[index]!;
        expect(drawing.shape).toBe(expected.shape);
        for (const coordinate of ['x', 'y', 'width', 'thickness'] as const) {
          expect(drawing[coordinate]).toBeCloseTo(expected[coordinate], 3);
        }
      });
      for (const mark of groundTruth.decorations) {
        const item = items.find((item) => item.str === mark.text)!;
        expect(item).toBeDefined();
        expect(position(item).x).toBeCloseTo(mark.x, 3);
        // PDF.js and pdf-lib differ slightly in standard-font kerning metrics.
        expect(Math.abs(item.width - mark.width)).toBeLessThan(0.25);
        const baseline = position(item).y;
        if (mark.status === 'deleted') {
          expect(mark.y).toBeGreaterThan(baseline + item.height / 3);
          expect(mark.y).toBeLessThan(baseline + (item.height * 2) / 3);
        } else {
          expect(mark.y).toBeCloseTo(baseline - 0.8);
        }
      }
    });
  });

  it.each([0, 1, 4, 2.5, NaN, Infinity])(
    'rejects unsupported page count %s',
    async (pageCount) => {
      await expect(makeAmendingBillPdf({ pageCount })).rejects.toThrow(
        RangeError,
      );
    },
  );
});

describe('other PDF reader round-trips', () => {
  it('reads federal section and subsection labels without a line-number band', async () => {
    const { bytes, groundTruth } = await makeFederalStylePdf();
    await withPdf(bytes, async (doc) => {
      expect(doc.numPages).toBe(1);
      const items = await textItems(doc, 1);
      expect(items.filter((item) => /^\d+$/.test(item.str))).toEqual([]);
      expect(items.every((item) => position(item).x === 72)).toBe(true);
      expect(
        items
          .filter((item) => item.str.startsWith('SEC.'))
          .map((item) => /^SEC\. (\d+)\./.exec(item.str)?.[1]),
      ).toEqual(groundTruth.sections.map((s) => s.num));
      for (const section of walkSections(groundTruth.sections)) {
        Section.parse(section);
        expect(section).not.toHaveProperty('lineStart');
        for (const span of section.spans)
          expect(items.some((item) => item.str.includes(span.text))).toBe(true);
        if (section.level > 1)
          expect(items.some((item) => item.str.startsWith(section.num!))).toBe(
            true,
          );
      }
    });
  });

  it('finds shapes but zero text items in the scanned sample', async () => {
    const { bytes, groundTruth } = await makeScannedPdf();
    await withPdf(bytes, async (doc) => {
      expect(doc.numPages).toBe(1);
      expect((await (await doc.getPage(1)).getTextContent()).items).toEqual([]);
      const operators = await (await doc.getPage(1)).getOperatorList();
      expect(
        operators.fnArray.filter((fn) => fn === OPS.constructPath),
      ).toHaveLength(12);
      expect(groundTruth.sections).toEqual([]);
    });
  });

  it('rejects truncated generated bytes', async () => {
    const { bytes } = await makeFederalStylePdf();
    await expect(
      withPdf(bytes.slice(0, 20), async () => Promise.resolve()),
    ).rejects.toThrow();
  });
});

describe('amendment geometry PDF round-trip', () => {
  it('prints every line under a per-page line number, with header and footer', async () => {
    const { bytes, groundTruth } = await makeAmendmentGeometryPdf();
    await withPdf(bytes, async (doc) => {
      expect(doc.numPages).toBe(2);
      for (const page of groundTruth.pages) {
        const items = await textItems(doc, page.page);
        expect(items.some((item) => item.str === page.header)).toBe(true);
        expect(items.some((item) => item.str === page.footer)).toBe(true);
        const lines = Object.entries(page.lines);
        expect(lines.map(([line]) => Number(line))).toEqual(
          lines.map((_, index) => index + 1),
        );
        for (const [line, expectedText] of lines) {
          const y =
            groundTruth.layout.firstLineY -
            (Number(line) - 1) * groundTruth.layout.lineSpacing;
          const row = items.filter((item) => position(item).y === y);
          expect(
            row
              .filter(
                (item) => position(item).x === groundTruth.layout.lineNumberX,
              )
              .map((item) => item.str),
          ).toEqual([line]);
          expect(
            row
              .filter((item) => position(item).x >= groundTruth.layout.textX)
              .map((item) => item.str)
              .join('')
              .replace(/\s+/g, ' '),
          ).toBe(expectedText.replace(/\s+/g, ' '));
        }
      }
    });
  });

  it('draws one path per true mark and per negative control', async () => {
    const { bytes, groundTruth } = await makeAmendmentGeometryPdf();
    await withPdf(bytes, async (doc) => {
      let paths = 0;
      for (const page of [1, 2]) {
        const operators = await (await doc.getPage(page)).getOperatorList();
        paths += operators.fnArray.filter(
          (fn) => fn === OPS.constructPath,
        ).length;
      }
      expect(paths).toBe(
        groundTruth.decorations.length + groundTruth.controls.length,
      );
    });
  });

  it('places true marks in their typographic bands and covers struck and inserted strings', async () => {
    const { groundTruth } = await makeAmendmentGeometryPdf();
    const { fontSize, firstLineY, lineSpacing } = groundTruth.layout;
    for (const mark of groundTruth.decorations) {
      const baseline = firstLineY - (mark.line - 1) * lineSpacing;
      const centre =
        mark.shape === 'rect' ? mark.y + mark.thickness / 2 : mark.y;
      const offset = (centre - baseline) / fontSize;
      if (mark.status === 'deleted') {
        expect(offset).toBeGreaterThan(0.2);
        expect(offset).toBeLessThan(0.45);
      } else {
        expect(offset).toBeGreaterThan(-0.3);
        expect(offset).toBeLessThan(0);
      }
      const strings =
        mark.status === 'deleted'
          ? groundTruth.deletedStrings
          : groundTruth.insertedStrings;
      expect(strings).toContain(mark.text.trim());
    }
    expect(
      new Set(groundTruth.controls.map((control) => control.name)).size,
    ).toBe(groundTruth.controls.length);
    for (const section of walkSections(groundTruth.sections))
      Section.parse(section);
  });
});
