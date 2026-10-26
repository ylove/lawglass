import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  classifyScanPage,
  imageCoverage,
  OCR_PRODUCER,
  scanOperators,
  type ImagePlacement,
  type PageScanStats,
} from './pdf-scan.js';

type Entry = [number, unknown];
const walk = (...entries: Entry[]) =>
  scanOperators(
    entries.map(([fn]) => fn),
    entries.map(([, args]) => args),
    OPS,
  );

/** Glyph objects as PDF.js lists them in showText arguments. */
const glyphs = (text: string): unknown[] =>
  Array.from(text, (char) => ({
    unicode: char,
    width: 500,
    ...(char === ' ' ? { isSpace: true } : {}),
  }));
const show = (text: string): Entry => [OPS.showText, [glyphs(text)]];
const mode = (value: number): Entry => [OPS.setTextRenderingMode, [value]];
const image = (...matrix: number[]): Entry[] => [
  [OPS.save, null],
  [OPS.transform, matrix],
  [OPS.paintImageXObject, ['img', 10, 10]],
  [OPS.restore, null],
];
const view = { x0: 0, y0: 0, x1: 612, y1: 792 };
const placement = (x0: number, y0: number, x1: number, y1: number) =>
  ({ ctm: [1, 0, 0, 1, 0, 0], rect: { x0, y0, x1, y1 } }) as ImagePlacement;

describe('scanOperators', () => {
  it('counts visible glyphs by default and skips spaces and spacing numbers', () => {
    const stats = walk([OPS.showSpacedText, [[...glyphs('ab c'), -120, null]]]);
    expect(stats).toMatchObject({ visibleGlyphs: 3, invisibleGlyphs: 0 });
  });

  it.each([3, 7])('counts render mode %i as invisible', (value) => {
    expect(walk(mode(value), show('abcd'))).toMatchObject({
      visibleGlyphs: 0,
      invisibleGlyphs: 4,
    });
  });

  it.each([0, 1, 2, 4, 5, 6])('counts render mode %i as visible', (value) => {
    expect(walk(mode(value), show('abcd'))).toMatchObject({
      visibleGlyphs: 4,
      invisibleGlyphs: 0,
    });
  });

  it('restores the render mode with Q', () => {
    const stats = walk(
      [OPS.save, null],
      mode(3),
      show('ab'),
      [OPS.restore, null],
      show('cde'),
    );
    expect(stats).toMatchObject({ visibleGlyphs: 3, invisibleGlyphs: 2 });
  });

  it('keeps a mode set outside q/Q for the text inside it', () => {
    const stats = walk(
      mode(3),
      [OPS.save, null],
      show('ab'),
      [OPS.restore, null],
      show('cd'),
    );
    expect(stats).toMatchObject({ visibleGlyphs: 0, invisibleGlyphs: 4 });
  });

  it('scopes the mode to a form XObject', () => {
    const stats = walk(
      [OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 0], null]],
      mode(3),
      show('ab'),
      [OPS.paintFormXObjectEnd, null],
      show('c'),
    );
    expect(stats).toMatchObject({ visibleGlyphs: 1, invisibleGlyphs: 2 });
  });

  it('reads every text-showing operator form', () => {
    const stats = walk(
      mode(3),
      [OPS.nextLineShowText, [glyphs('ab')]],
      [OPS.nextLineSetSpacingShowText, [1, 2, glyphs('cde')]],
    );
    expect(stats.invisibleGlyphs).toBe(5);
  });

  it('ignores malformed text operators and mode arguments', () => {
    const stats = walk(
      [OPS.setTextRenderingMode, ['x']],
      [OPS.showText, null],
      [OPS.showText, [7]],
      [OPS.nextLineSetSpacingShowText, [1, 2, 'no']],
      [OPS.transform, ['bad']],
      [OPS.paintFormXObjectBegin, ['bad']],
      show('a'),
    );
    expect(stats).toMatchObject({ visibleGlyphs: 1, invisibleGlyphs: 0 });
  });

  it('records each image with its transform and covered box', () => {
    const stats = walk(...image(612, 0, 0, 792, 0, 0));
    expect(stats.images).toEqual([
      { ctm: [612, 0, 0, 792, 0, 0], rect: { x0: 0, y0: 0, x1: 612, y1: 792 } },
    ]);
  });

  it('composes nested transforms and covers mask and inline images', () => {
    const stats = walk(
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 100, 200]],
      [OPS.paintFormXObjectBegin, [[2, 0, 0, 2, 0, 0], null]],
      [OPS.paintImageMaskXObject, [{}]],
      [OPS.paintInlineImageXObject, [{}]],
      [OPS.paintFormXObjectEnd, null],
      [OPS.restore, null],
    );
    expect(stats.images.map((entry) => entry.rect)).toEqual([
      { x0: 100, y0: 200, x1: 102, y1: 202 },
      { x0: 100, y0: 200, x1: 102, y1: 202 },
    ]);
  });
});

describe('imageCoverage', () => {
  it('is zero without images or for an empty page box', () => {
    expect(imageCoverage([], view)).toBe(0);
    expect(imageCoverage([placement(0, 0, 10, 10)], { ...view, x1: 0 })).toBe(
      0,
    );
  });

  it('is the full page for one page-sized image', () => {
    expect(imageCoverage([placement(0, 0, 612, 792)], view)).toBe(1);
  });

  it('adds up strips that tile the page', () => {
    const strips = [0, 1, 2, 3].map((i) =>
      placement(0, i * 198, 612, (i + 1) * 198),
    );
    expect(imageCoverage(strips, view)).toBeCloseTo(1);
  });

  it('does not count overlapping images twice', () => {
    const covered = imageCoverage(
      [placement(0, 0, 612, 400), placement(0, 200, 612, 600)],
      view,
    );
    expect(covered).toBeCloseTo(600 / 792);
  });

  it('counts only the part of an image on the page', () => {
    expect(imageCoverage([placement(-612, 0, 306, 792)], view)).toBeCloseTo(
      0.5,
    );
    expect(imageCoverage([placement(700, 0, 800, 100)], view)).toBe(0);
  });

  it('is partial for a letterhead image', () => {
    expect(imageCoverage([placement(36, 700, 200, 760)], view)).toBeLessThan(
      0.05,
    );
  });
});

describe('classifyScanPage', () => {
  const stats = (overrides: Partial<PageScanStats>): PageScanStats => ({
    visibleGlyphs: 0,
    invisibleGlyphs: 0,
    ocrGlyphs: overrides.invisibleGlyphs ?? 0,
    images: [],
    ...overrides,
  });
  const full = [placement(0, 0, 612, 792)];

  it('calls all-invisible text an OCR scan with or without an image', () => {
    expect(classifyScanPage(stats({ invisibleGlyphs: 9 }), view, false)).toBe(
      'invisible-text',
    );
    expect(
      classifyScanPage(
        stats({ invisibleGlyphs: 9, images: full }),
        view,
        false,
      ),
    ).toBe('invisible-text');
  });

  it('still calls a page a scan when a visible footer or stamp was added', () => {
    // 9 invisible glyphs to 1 visible is exactly the 90% line, with no image at all.
    expect(
      classifyScanPage(
        stats({ invisibleGlyphs: 9, visibleGlyphs: 1 }),
        view,
        false,
      ),
    ).toBe('invisible-text');
    expect(
      classifyScanPage(
        stats({ invisibleGlyphs: 900, visibleGlyphs: 30 }),
        view,
        false,
      ),
    ).toBe('invisible-text');
  });

  it('does not count mode-7 text over a page image: layout tools fill titles with images', () => {
    const page = walk(...image(612, 0, 0, 792, 0, 0), mode(7), show('Title'));
    expect(page.invisibleGlyphs).toBe(5);
    expect(page.ocrGlyphs).toBe(0);
    const body = walk(mode(0), show('a'.repeat(200)));
    const mixed: PageScanStats = {
      ...page,
      visibleGlyphs: body.visibleGlyphs,
    };
    expect(classifyScanPage(mixed, view, false)).toBeUndefined();
    expect(
      classifyScanPage(
        walk(...image(612, 0, 0, 792, 0, 0), mode(3), show('Title')),
        view,
        false,
      ),
    ).toBe('invisible-text');
  });

  it('calls a page with mostly visible text and no page image not a scan', () => {
    expect(
      classifyScanPage(
        stats({ invisibleGlyphs: 8, visibleGlyphs: 2 }),
        view,
        false,
      ),
    ).toBeUndefined();
    // Invisible text over a small image (a hidden accessibility label) is not a scan.
    expect(
      classifyScanPage(
        stats({
          invisibleGlyphs: 5,
          visibleGlyphs: 500,
          images: [placement(0, 0, 100, 100)],
        }),
        view,
        false,
      ),
    ).toBeUndefined();
  });

  it('calls any invisible text over a page-covering image a scan, whatever else is visible', () => {
    expect(
      classifyScanPage(
        stats({ invisibleGlyphs: 5, visibleGlyphs: 500, images: full }),
        view,
        false,
      ),
    ).toBe('invisible-text');
  });

  it('calls visible text over a page image a scan only with an OCR producer', () => {
    const page = stats({ visibleGlyphs: 50, images: full });
    expect(classifyScanPage(page, view, true)).toBe('clearscan');
    expect(classifyScanPage(page, view, false)).toBeUndefined();
  });

  it('needs the image to cover the page', () => {
    const page = stats({
      visibleGlyphs: 50,
      images: [placement(0, 0, 612, 600)],
    });
    expect(classifyScanPage(page, view, true)).toBeUndefined();
  });

  it('calls a page without text or with plain text not a scan', () => {
    expect(
      classifyScanPage(stats({ images: full }), view, true),
    ).toBeUndefined();
    expect(classifyScanPage(stats({ visibleGlyphs: 5 }), view, true)).toBe(
      undefined,
    );
  });
});

describe('OCR_PRODUCER', () => {
  it.each([
    'Adobe Acrobat (64-bit) 26 Paper Capture Plug-in',
    'Adobe ClearScan',
    'ABBYY FineReader OCR',
    'OCRmyPDF 16.1',
    'ABBYY FineReader 15',
  ])('matches %s', (value) => {
    expect(OCR_PRODUCER.test(value)).toBe(true);
  });
  it.each([
    'Microsoft Word',
    'pdf-lib',
    'Quartz PDFContext',
    'Dominion Democracy Suite 5.17',
    'DocRaptor',
    'Socrata',
    'Mediocre Print Co',
  ])('does not match %s', (value) => {
    expect(OCR_PRODUCER.test(value)).toBe(false);
  });
});
