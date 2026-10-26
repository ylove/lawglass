import { describe, expect, it } from 'vitest';
import {
  getDocument,
  OPS,
  PDFWorker,
  type PDFDocumentProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import jpeg from 'jpeg-js';
import {
  SCANNED_PRESET_NAMES,
  SCANNED_PRESETS,
  inkPositionAfterSkew,
  makeScannedPreset,
  makeScannedRedlinePdf,
  parseWordMarkup,
  type ScannedPdf,
} from './scanned-pdf.js';
import { glyphFor, isSupportedChar, wordWidthCells } from './scanned-font.js';

async function withPdf(
  bytes: Uint8Array,
  check: (doc: PDFDocumentProxy) => Promise<void>,
): Promise<void> {
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

async function inspect(bytes: Uint8Array) {
  const result = {
    items: [] as { str: string; x: number; y: number }[][],
    imageOps: [] as number[],
    renderModes: new Set<number>(),
  };
  await withPdf(bytes, async (doc) => {
    for (let n = 1; n <= doc.numPages; n += 1) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      result.items.push(
        content.items.flatMap((item) =>
          'str' in item && item.str.trim() !== ''
            ? [
                {
                  str: item.str,
                  x: item.transform[4] as number,
                  y: item.transform[5] as number,
                },
              ]
            : [],
        ),
      );
      const list = await page.getOperatorList();
      let images = 0;
      list.fnArray.forEach((fn, index) => {
        if (fn === OPS.paintImageXObject) images += 1;
        if (fn === OPS.setTextRenderingMode) {
          const args = list.argsArray[index] as number[];
          result.renderModes.add(args[0]!);
        }
      });
      result.imageOps.push(images);
    }
  });
  return result;
}

describe('parseWordMarkup', () => {
  it('parses plain, struck, inserted and merged words', () => {
    expect(parseWordMarkup('plain')).toEqual([
      { text: 'plain', status: 'unchanged' },
    ]);
    expect(parseWordMarkup('[-old-]{+new+}s')).toEqual([
      { text: 'old', status: 'struck' },
      { text: 'new', status: 'inserted' },
      { text: 's', status: 'unchanged' },
    ]);
    expect(parseWordMarkup('[-e-mail-]')).toEqual([
      { text: 'e-mail', status: 'struck' },
    ]);
  });

  it('rejects unbalanced markup', () => {
    expect(() => parseWordMarkup('[-open')).toThrow(/Bad scanned-page markup/);
    expect(() => parseWordMarkup('{+x')).toThrow(/Bad scanned-page markup/);
  });
});

describe('scanned font', () => {
  it('has rectangular glyphs for every supported character', () => {
    const chars =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;:!?\'"()/-\u2013\u2014'.split(
        '',
      );
    for (const char of chars) {
      const glyph = glyphFor(char);
      expect(glyph.rows.every((row) => row.length === glyph.width)).toBe(true);
      expect(glyph.top + glyph.rows.length).toBeLessThanOrEqual(9);
    }
  });

  it('rejects unsupported characters', () => {
    expect(isSupportedChar('~')).toBe(false);
    expect(() => glyphFor('~')).toThrow(/no glyph/);
  });

  it('measures words without a trailing gap', () => {
    expect(wordWidthCells('a')).toBe(5);
    expect(wordWidthCells('ab')).toBe(11);
  });
});

describe('makeScannedRedlinePdf', () => {
  it('is deterministic for a seed and differs for another seed with noise', async () => {
    const options = { pages: [['a [-b-] {+c+}']], noise: 0.5, seed: 4 };
    const a = await makeScannedRedlinePdf(options);
    const b = await makeScannedRedlinePdf(options);
    const c = await makeScannedRedlinePdf({ ...options, seed: 5 });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.truth).toEqual(b.truth);
    expect(Buffer.from(a.bytes).equals(Buffer.from(c.bytes))).toBe(false);
    // Three full PDF renders; a loaded CI runner has taken over 15 s.
  }, 60_000);

  it('returns words in text-item order with exact statuses and mark geometry', async () => {
    const { bytes, truth } = await makeScannedRedlinePdf({
      pages: [['one [-two-] {+three+} [-four-]{+five+}', '', 'six']],
    });
    const page = truth.pages[0]!;
    expect(page.words.map((w) => [w.text, w.status, w.line])).toEqual([
      ['one', 'unchanged', 0],
      ['two', 'struck', 0],
      ['three', 'inserted', 0],
      ['fourfive', 'mixed', 0],
      ['six', 'unchanged', 2],
    ]);
    const [, two, three, merged] = page.words;
    // Strike through the x-height middle, underline just below the baseline.
    const cell = 12 / 9;
    expect(two!.marks).toHaveLength(1);
    expect(two!.marks[0]!.kind).toBe('strike');
    expect(two!.marks[0]!.y).toBeCloseTo(two!.baselineY + 2.5 * cell);
    expect(two!.marks[0]!.y).toBeGreaterThan(two!.baselineY);
    expect(two!.marks[0]!.y).toBeLessThan(two!.xHeightTopY);
    expect(three!.marks[0]!.kind).toBe('underline');
    expect(three!.marks[0]!.y).toBeLessThan(three!.baselineY);
    expect(merged!.parts.map((p) => [p.text, p.startChar, p.endChar])).toEqual([
      ['four', 0, 4],
      ['five', 4, 8],
    ]);
    expect(merged!.marks.map((m) => m.kind)).toEqual(['strike', 'underline']);
    // The strike stops where the inserted text starts; marks do not overlap.
    expect(merged!.marks[0]!.x1).toBeLessThanOrEqual(merged!.marks[1]!.x0);
    expect(merged!.marks[0]!.x0).toBeLessThan(merged!.parts[0]!.x0);

    const found = await inspect(bytes);
    expect(found.items[0]!.map((item) => item.str)).toEqual(
      page.words.map((word) => word.text),
    );
    found.items[0]!.forEach((item, index) => {
      expect(item.x).toBeCloseTo(page.words[index]!.box.x, 1);
      expect(item.y).toBeCloseTo(page.words[index]!.baselineY, 1);
    });
  });

  it('writes a Flate image under an invisible text layer', async () => {
    const { bytes } = await makeScannedRedlinePdf({ pages: [['a [-b-]']] });
    const found = await inspect(bytes);
    expect(found.imageOps).toEqual([1]);
    expect([...found.renderModes]).toEqual([3]);
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).toContain('/FlateDecode');
    expect(raw).not.toContain('/DCTDecode');
  });

  it('writes a decodable JPEG image with an embedded raster of the right size', async () => {
    const { bytes, truth } = await makeScannedRedlinePdf({
      pages: [['a [-b-]']],
      encoding: 'jpeg',
      dpi: 100,
    });
    expect(Buffer.from(bytes).toString('latin1')).toContain('/DCTDecode');
    expect((await inspect(bytes)).imageOps).toEqual([1]);
    // Extract the JPEG stream and decode it independently.
    const buf = Buffer.from(bytes);
    const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2;
    const decoded = jpeg.decode(buf.subarray(start, end), {
      useTArray: true,
    });
    expect([decoded.width, decoded.height]).toEqual([
      truth.pages[0]!.widthPx,
      truth.pages[0]!.heightPx,
    ]);
  });

  it('splits the image into strips that tile the page', async () => {
    const { bytes, truth } = await makeScannedRedlinePdf({
      pages: [['a [-b-]']],
      strips: 3,
      dpi: 100,
    });
    const page = truth.pages[0]!;
    expect(page.stripRows).toHaveLength(3);
    expect(page.stripRows[0]![0]).toBe(0);
    expect(page.stripRows[2]![1]).toBe(page.heightPx);
    page.stripRows.slice(1).forEach((rows, i) => {
      expect(rows[0]).toBe(page.stripRows[i]![1]);
    });
    expect((await inspect(bytes)).imageOps).toEqual([3]);
  });

  it('omits the image entirely for noImage', async () => {
    const { bytes, truth } = await makeScannedRedlinePdf({
      pages: [['a [-b-]']],
      noImage: true,
    });
    const found = await inspect(bytes);
    expect(found.imageOps).toEqual([0]);
    expect(found.items[0]).toHaveLength(2);
    expect(truth.pages[0]!.stripRows).toEqual([]);
  });

  it('supports several pages', async () => {
    const { bytes, truth } = await makeScannedRedlinePdf({
      pages: [['one'], ['two [-three-]']],
      dpi: 100,
    });
    expect(truth.pages).toHaveLength(2);
    const found = await inspect(bytes);
    expect(found.items.map((items) => items.length)).toEqual([1, 2]);
    expect(found.imageOps).toEqual([1, 1]);
  });

  it('puts ink where the truth says: strike dark, nearby gap light', async () => {
    const { truth, bytes } = await makeScannedRedlinePdf({
      pages: [['[-ee-] {+ee+} ee']],
      encoding: 'jpeg',
      dpi: 150,
      markThicknessPx: 3,
    });
    expect(bytes.length).toBeGreaterThan(0);
    // Re-render without PDF: decode the JPEG strip via the same generator path.
    const buf = Buffer.from(bytes);
    const start = buf.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
    const end = buf.lastIndexOf(Buffer.from([0xff, 0xd9])) + 2;
    const img = jpeg.decode(buf.subarray(start, end), { useTArray: true });
    const page = truth.pages[0]!;
    const scale = page.dpi / 72;
    const luma = (xPt: number, yPt: number): number => {
      const x = Math.round(xPt * scale);
      const y = Math.round((page.heightPt - yPt) * scale);
      return img.data[(y * img.width + x) * 4]!;
    };
    const [struck, inserted, plain] = page.words;
    const strike = struck!.marks[0]!;
    const midX = (strike.x0 + strike.x1) / 2;
    expect(luma(midX, strike.y)).toBeLessThan(80);
    const under = inserted!.marks[0]!;
    expect(luma((under.x0 + under.x1) / 2, under.y)).toBeLessThan(80);
    // The unmarked word has no underline.
    expect(luma(plain!.box.x + 8, plain!.baselineY - 2)).toBeGreaterThan(200);
    // Blank paper far from any text.
    expect(luma(300, 100)).toBeGreaterThan(240);
  });

  it('skews ink but not the OCR layer', async () => {
    const flat = await makeScannedRedlinePdf({ pages: [['aaa']] });
    const tilted = await makeScannedRedlinePdf({
      pages: [['aaa']],
      skewDegrees: 2,
    });
    expect(tilted.truth.pages[0]!.words).toEqual(flat.truth.pages[0]!.words);
    expect(tilted.truth.pages[0]!.skewDegrees).toBe(2);
    expect(Buffer.from(tilted.bytes).equals(Buffer.from(flat.bytes))).toBe(
      false,
    );
    const found = await inspect(tilted.bytes);
    expect(found.items[0]![0]!.x).toBeCloseTo(
      flat.truth.pages[0]!.words[0]!.box.x,
      1,
    );
  });

  it('maps points through the skew like the raster rotation', () => {
    expect(inkPositionAfterSkew({ x: 100, y: 200 }, 0)).toEqual({
      x: 100,
      y: 200,
    });
    // Clockwise rotation moves a point on the right of centre downward.
    const moved = inkPositionAfterSkew({ x: 500, y: 396 }, 2);
    expect(moved.y).toBeLessThan(396);
    // 2 degrees over the 194pt from the page centre to x=500.
    expect(396 - moved.y).toBeCloseTo(194 * Math.sin((2 * Math.PI) / 180), 1);
  });

  it('adds grain only when noise is requested', async () => {
    const clean = await makeScannedRedlinePdf({
      pages: [['a']],
      encoding: 'flate',
    });
    const noisy = await makeScannedRedlinePdf({
      pages: [['a']],
      noise: 1,
    });
    expect(noisy.bytes.length).toBeGreaterThan(clean.bytes.length);
  });

  it.each([
    [{ dpi: 10 }, /dpi/],
    [{ strips: 0 }, /strips/],
    [{ strips: 2.5 }, /strips/],
    [{ noise: 2 }, /noise/],
    [{ markThicknessPx: 0 }, /markThicknessPx/],
    [{ pages: [] }, /pages/],
  ])('rejects bad options %j', async (bad, message) => {
    await expect(
      makeScannedRedlinePdf({ pages: [['a']], ...bad }),
    ).rejects.toThrow(message);
  });

  it('rejects over-long lines and unsupported characters', async () => {
    await expect(
      makeScannedRedlinePdf({ pages: [['word '.repeat(40)]] }),
    ).rejects.toThrow(/too long/);
    await expect(
      makeScannedRedlinePdf({ pages: [['tilde~']] }),
    ).rejects.toThrow(/no glyph/);
  });
});

describe('scanned presets', () => {
  it('defines every required case', () => {
    expect(Object.keys(SCANNED_PRESETS).sort()).toEqual(
      [...SCANNED_PRESET_NAMES].sort(),
    );
  });

  const built = new Map<string, ScannedPdf>();
  it.each(SCANNED_PRESET_NAMES)('builds %s', async (name) => {
    const result = await makeScannedPreset(name);
    built.set(name, result);
    const found = await inspect(result.bytes);
    const words = result.truth.pages[0]!.words;
    expect(found.items[0]!.map((item) => item.str)).toEqual(
      words.map((word) => word.text),
    );
    expect([...found.renderModes]).toEqual([3]);
    expect(found.imageOps[0]).toBe(
      name === 'no-image' ? 0 : name === 'strips' ? 4 : 1,
    );
  });

  it('clean keeps struck and inserted words on separate lines', () => {
    const words = built.get('clean')!.truth.pages[0]!.words;
    const lines = (status: string) =>
      new Set(words.filter((w) => w.status === status).map((w) => w.line));
    for (const line of lines('struck'))
      expect(lines('inserted').has(line)).toBe(false);
  });

  it('merged has OCR words spanning struck and inserted text', () => {
    const words = built.get('merged')!.truth.pages[0]!.words;
    const mixed = words.filter((w) => w.status === 'mixed');
    expect(mixed.length).toBeGreaterThanOrEqual(3);
    for (const word of mixed) {
      const statuses = word.parts.map((p) => p.status);
      expect(statuses).toContain('struck');
      expect(statuses).toContain('inserted');
    }
  });

  it('tricky-negatives has no marks and plenty of e and dashes', () => {
    const words = built.get('tricky-negatives')!.truth.pages[0]!.words;
    expect(words.every((w) => w.marks.length === 0)).toBe(true);
    const text = words.map((w) => w.text).join(' ');
    expect((text.match(/e/g) ?? []).length).toBeGreaterThan(30);
    expect(text).toMatch(/-/);
    expect(text).toContain('–');
    expect(text).toContain('—');
  });

  it('short-words strikes one- and two-letter words', () => {
    const struck = built
      .get('short-words')!
      .truth.pages[0]!.words.filter((w) => w.status === 'struck');
    expect(struck.some((w) => w.text.length === 1)).toBe(true);
    expect(struck.some((w) => w.text.length === 2)).toBe(true);
    // The strike extends past the glyph ink so a detector can tell it from a glyph stroke.
    for (const word of struck) {
      expect(word.marks[0]!.x0).toBeLessThan(word.parts[0]!.x0);
      expect(word.marks[0]!.x1).toBeGreaterThan(word.parts[0]!.x1);
    }
  });

  it('records the abstain-case resolution and skew', () => {
    expect(built.get('skewed')!.truth.pages[0]!.skewDegrees).toBe(2);
    expect(built.get('low-dpi')!.truth.pages[0]!.dpi).toBe(90);
  });

  it('allows overrides on a preset', async () => {
    const result = await makeScannedPreset('clean', { dpi: 120 });
    expect(result.truth.pages[0]!.dpi).toBe(120);
  });
});
