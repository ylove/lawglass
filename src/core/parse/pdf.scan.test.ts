/**
 * OCR-scan detection, scan skew and word joining through the whole parser (issue #192,
 * docs/decisions/0010). Unit-level cases are in pdf-scan.test.ts and pdf-lines.test.ts.
 */
import {
  degrees,
  PDFDocument,
  rgb,
  StandardFonts,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import {
  makeScannedPreset,
  SCAN_PIXEL,
  SCANNED_PRESET_NAMES,
} from '../../../tests/synth/index.js';
import { sectionText, walkSections, type Span } from '../model/index.js';
import { parsePdf } from './index.js';
import { SCAN_WARNING } from './pdf.js';

const options = {
  sourceUrl: 'https://example.gov/scan.pdf',
  fetchedAt: '2026-10-14T00:00:00.000Z',
};
const OCR_PRODUCER = 'Adobe Acrobat (64-bit) 26 Paper Capture Plug-in';

const text = (sections: Parameters<typeof walkSections>[0]): string =>
  [...walkSections(sections)]
    .map((section) => sectionText(section, { includeDeleted: true }))
    .join('\n');
const spans = (sections: Parameters<typeof walkSections>[0]): Span[] =>
  [...walkSections(sections)].flatMap((section) => section.spans);

describe('OCR scans: invisible text over a page image', () => {
  it.each(SCANNED_PRESET_NAMES)(
    'parses the %s preset, warns, and marks the page not-read',
    async (name) => {
      const { bytes, truth } = await makeScannedPreset(name);
      const doc = await parsePdf(bytes, options);
      expect(doc.warnings).toContain(SCAN_WARNING);
      expect(doc.scan).toEqual({ pages: [{ page: 1, marks: 'not-read' }] });
      expect(text(doc.sections)).toContain(truth.pages[0]!.words[0]!.text);
    },
  );

  it('flags only the OCR pages of a mixed document', async () => {
    const { bytes } = await makeScannedPreset('clean', {
      pages: [
        [
          'Section 1. The first page holds',
          'enough words to be a real page',
          'of text for the parser to read.',
        ],
        [
          'Section 2. The second page also',
          'holds enough words to count as',
          'text for the parser to read.',
        ],
      ],
    });
    const doc = await parsePdf(bytes, options);
    expect(doc.scan?.pages.map((page) => page.page)).toEqual([1, 2]);
    expect(doc.warnings.filter((w) => w === SCAN_WARNING)).toHaveLength(1);
  });

  it('never reports an OCR-scan page as read', async () => {
    const { bytes } = await makeScannedPreset('strips');
    const doc = await parsePdf(bytes, options);
    expect(doc.scan?.pages.every((page) => page.marks !== 'read')).toBe(true);
  });
});

/** Visible text over an image of `coverage` of the page, in `strips` bands, as ClearScan does. */
async function clearScanLike(opts: {
  producer: string;
  coverage?: number;
  strips?: number;
}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setProducer(opts.producer);
  const font = await pdf.embedFont(StandardFonts.TimesRoman);
  const page = pdf.addPage([612, 792]);
  const image = await pdf.embedPng(SCAN_PIXEL);
  const { coverage = 1, strips = 1 } = opts;
  const bandHeight = (792 * coverage) / strips;
  for (let index = 0; index < strips; index++)
    page.drawImage(image, {
      x: 0,
      y: index * bandHeight,
      width: 612,
      height: bandHeight,
    });
  for (const [index, line] of [
    'Section 1. The board shall adopt rules for the program.',
    'The rules shall take effect on the first day of July.',
  ].entries())
    page.drawText(line, { x: 72, y: 700 - index * 16, size: 11, font });
  return pdf.save();
}

describe('OCR scans: ClearScan, visible text over a page image', () => {
  it('is detected with an OCR producer and a page-covering image', async () => {
    const doc = await parsePdf(
      await clearScanLike({ producer: OCR_PRODUCER }),
      options,
    );
    expect(doc.warnings).toContain(SCAN_WARNING);
    expect(doc.scan).toEqual({ pages: [{ page: 1, marks: 'not-read' }] });
    expect(text(doc.sections)).toContain('The board shall adopt rules');
  });

  it('counts page strips as one covering image', async () => {
    const doc = await parsePdf(
      await clearScanLike({ producer: OCR_PRODUCER, strips: 4 }),
      options,
    );
    expect(doc.scan?.pages).toHaveLength(1);
  });

  it('is not flagged without an OCR producer', async () => {
    const doc = await parsePdf(
      await clearScanLike({ producer: 'Microsoft Word' }),
      options,
    );
    expect(doc.scan).toBeUndefined();
    expect(doc.warnings).not.toContain(SCAN_WARNING);
  });

  it('is not flagged when the image covers only part of the page', async () => {
    const doc = await parsePdf(
      await clearScanLike({ producer: OCR_PRODUCER, coverage: 0.5 }),
      options,
    );
    expect(doc.scan).toBeUndefined();
  });
});

describe('a text PDF', () => {
  it('has no scan status or warning', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    pdf.addPage().drawText('Section 1. The board shall adopt rules.', {
      x: 72,
      y: 700,
      size: 11,
      font,
    });
    const doc = await parsePdf(await pdf.save(), options);
    expect(doc.scan).toBeUndefined();
    expect(doc.warnings).not.toContain(SCAN_WARNING);
  });
});

describe('scan skew', () => {
  const LINES = [
    'Section 1. The question of the removal of the elective officer shall be submitted to the electors.',
    'The clerk shall order a special election within the period provided in this section.',
    'Section 2. The board shall report the result of the election to the council each year.',
  ];

  async function skewedPdf(
    angle: number,
    markWord?: string,
  ): Promise<Uint8Array> {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.TimesRoman);
    const page = pdf.addPage([612, 792]);
    const size = 10;
    LINES.forEach((line, index) => {
      const y = 700 - index * 16;
      page.drawText(line, { x: 72, y, size, font, rotate: degrees(angle) });
      if (markWord && line.includes(markWord)) strike(page, font, line, y);
    });
    function strike(p: PDFPage, f: PDFFont, line: string, y: number): void {
      const before = line.slice(0, line.indexOf(markWord ?? ''));
      const x0 = 72 + f.widthOfTextAtSize(before, size);
      const x1 = x0 + f.widthOfTextAtSize(markWord ?? '', size);
      // A level rule (a point long at each end, as a pen strikes) through the middle of the x-height, where the skewed baseline is at its middle.
      const rise = Math.tan((angle * Math.PI) / 180) * ((x0 + x1) / 2 - 72);
      p.drawLine({
        start: { x: x0 - 1, y: y + rise + 3 },
        end: { x: x1 + 1, y: y + rise + 3 },
        thickness: 0.6,
        color: rgb(0, 0, 0),
      });
    }
    return pdf.save();
  }

  it('keeps a block skewed by 0.6 degrees intact, without a rotated-text warning', async () => {
    const doc = await parsePdf(await skewedPdf(0.6), options);
    const all = text(doc.sections).replace(/\s+/g, ' ');
    for (const line of LINES)
      expect(all).toContain(line.replace(/^Section \d\. /, ''));
    expect(doc.sections.map((s) => s.id)).toEqual(['sec-1', 'sec-2']);
    expect(doc.warnings.join('\n')).not.toMatch(/rotated/);
  });

  it('keeps a skew of 2 degrees, the limit, and drops 3 degrees as a stamp', async () => {
    const kept = await parsePdf(await skewedPdf(2), options);
    expect(text(kept.sections)).toContain('special election');
    const rotated = await PDFDocument.create();
    const font = await rotated.embedFont(StandardFonts.TimesRoman);
    const page = rotated.addPage();
    page.drawText('Section 1. Upright body text.', {
      x: 72,
      y: 700,
      size: 11,
      font,
    });
    page.drawText('RECEIVED BY THE CLERK', {
      x: 300,
      y: 300,
      size: 9,
      font,
      rotate: degrees(3),
    });
    const doc = await parsePdf(await rotated.save(), options);
    expect(text(doc.sections)).not.toContain('RECEIVED');
    expect(doc.warnings).toContain(
      'Page 1: rotated text (such as a stamp) was skipped.',
    );
  });

  it('reads skew in either direction', async () => {
    const doc = await parsePdf(await skewedPdf(-0.8), options);
    expect(doc.sections.map((s) => s.id)).toEqual(['sec-1', 'sec-2']);
  });

  it('matches a level rule against the skewed baseline at the rule, not at the line start', async () => {
    const doc = await parsePdf(await skewedPdf(0.6, 'electors'), options);
    const struck = spans(doc.sections)
      .filter((span) => span.status === 'deleted')
      .map((span) => span.text.trim());
    expect(struck).toEqual(['electors']);
  });
});
