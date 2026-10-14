import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import {
  baselineAt,
  classifyMarkHeight,
  collectGlyphWidths,
  extractMarkSegments,
  GEOMETRY,
  glyphExtents,
  lineY,
  markLine,
  maxMarkThickness,
  withoutLinkUnderlines,
  type GlyphWidths,
  type MarkSegment,
  type PdfTextItem,
} from './pdf-geometry.js';

// PDF.js path-data opcodes, as in pdf-geometry.ts.
const M = 0;
const L = 1;
const C = 2;
const Q = 3;
const Z = 4;

/** A minimal operator list: [fn, args] pairs. */
function ops(...entries: [number, unknown][]): [number[], unknown[]] {
  return [entries.map(([fn]) => fn), entries.map(([, args]) => args)];
}
const path = (paint: number, data: number[]): [number, unknown] => [
  OPS.constructPath,
  [paint, [new Float32Array(data)], null],
];
const segments = (...entries: [number, unknown][]): MarkSegment[] =>
  extractMarkSegments(...ops(...entries), OPS);

const item = (overrides: Partial<PdfTextItem> = {}): PdfTextItem => ({
  text: 'resident',
  x: 100,
  y: 500,
  width: 40,
  fontSize: 10,
  fontName: 'f1',
  ...overrides,
});
const noWidths: GlyphWidths = new Map();

describe('classifyMarkHeight', () => {
  const text = { y: 500, fontSize: 10 };
  it.each([
    ['the usual synthetic strike (0.4em)', 504, 'deleted'],
    ["Word's and Courier New's strikeout position (0.26em)", 502.6, 'deleted'],
    ['the bottom of the strike band (0.134em)', 501.34, 'deleted'],
    ['the top of the strike band (0.466em)', 504.66, 'deleted'],
    ['a just-below-baseline underline (-0.073em)', 499.27, 'inserted'],
    ["Ohio SB 203's underline (-0.133em)", 498.6, 'inserted'],
    ["Ohio SB 113's underline (-0.257em)", 497.3, 'inserted'],
    ['a rule on the baseline', 500, 'inserted'],
    ['a rule between the bands (0.09em)', 500.9, 'ambiguous'],
    ['an overline-ish rule high in the glyphs (0.6em)', 506, 'ambiguous'],
    ['a rule far below the descenders (-0.6em)', 494, undefined],
    ['a rule above the glyph box (0.9em)', 509, undefined],
  ])('classifies %s', (_, y, expected) => {
    expect(classifyMarkHeight(y, text)).toBe(expected);
  });

  it('scales with the font size', () => {
    expect(classifyMarkHeight(500 + 0.3 * 24, { y: 500, fontSize: 24 })).toBe(
      'deleted',
    );
    expect(classifyMarkHeight(500 - 0.2 * 24, { y: 500, fontSize: 24 })).toBe(
      'inserted',
    );
  });
});

describe('extractMarkSegments', () => {
  it('reads a stroked line through the current transform, as Ohio draws underlines', () => {
    expect(
      segments(
        [OPS.save, null],
        [OPS.transform, [1, 0, 0, 1, 111, 656.8]],
        [OPS.setLineWidth, [0.7]],
        path(OPS.stroke, [M, 0, -1.4, L, 308.7, -1.4]),
        [OPS.restore, null],
      ),
    ).toEqual([
      {
        x0: 111,
        x1: expect.closeTo(419.7, 3) as number,
        y: expect.closeTo(655.4, 3) as number,
        thickness: expect.closeTo(0.7, 5) as number,
      },
    ]);
  });

  it('restores the transform and line width after restore', () => {
    const [inner, outer] = segments(
      [OPS.setLineWidth, [0.5]],
      [OPS.save, null],
      [OPS.transform, [1, 0, 0, 1, 50, 50]],
      [OPS.setLineWidth, [1]],
      path(OPS.stroke, [M, 0, 0, L, 10, 0]),
      [OPS.restore, null],
      path(OPS.stroke, [M, 0, 0, L, 10, 0]),
    );
    expect(inner).toMatchObject({ x0: 50, y: 50, thickness: 1 });
    expect(outer).toMatchObject({ x0: 0, y: 0, thickness: 0.5 });
  });

  it('composes nested transforms and scales stroke width by the vertical axis', () => {
    const [segment] = segments(
      [OPS.transform, [2, 0, 0, 2, 10, 0]],
      [OPS.transform, [1, 0, 0, 1, 5, 100]],
      [OPS.setLineWidth, [0.5]],
      path(OPS.stroke, [M, 0, 0, L, 20, 0]),
    );
    expect(segment).toEqual({ x0: 20, x1: 60, y: 200, thickness: 1 });
  });

  it('accepts typed-array matrices and treats a zero line width as a hairline', () => {
    const [segment] = segments(
      [OPS.transform, new Float32Array([1, 0, 0, 1, 0, 10])],
      [OPS.setLineWidth, [0]],
      [OPS.constructPath, [OPS.stroke, [[M, 0, 0, L, 30, 0]], null]],
    );
    expect(segment).toEqual({ x0: 0, x1: 30, y: 10, thickness: 0 });
  });

  it('reads thin filled rectangles, including pdf-lib and closed variants', () => {
    expect(
      segments(
        [OPS.transform, [1, 0, 0, 1, 155.4, 529.2]],
        path(OPS.fill, [M, 0, 0, L, 0, 0.6, L, 126.73, 0.6, L, 126.73, 0, Z]),
      ),
    ).toEqual([
      {
        x0: 155.4,
        x1: expect.closeTo(282.13, 2) as number,
        y: expect.closeTo(529.5, 3) as number,
        thickness: expect.closeTo(0.6, 5) as number,
      },
    ]);
    expect(
      segments(path(OPS.eoFill, [M, 0, 0, L, 40, 0, L, 40, 1, L, 0, 1, Z])),
    ).toHaveLength(1);
  });

  it('keeps every thin subpath of one path', () => {
    expect(
      segments(
        path(OPS.stroke, [M, 0, 10, L, 50, 10, M, 0, 30, L, 80, 30, M, 5, 5]),
      ).map((segment) => segment.y),
    ).toEqual([10, 30]);
  });

  it.each([
    [
      'a box (table cell border)',
      OPS.stroke,
      [M, 0, 0, L, 100, 0, L, 100, 12, L, 0, 12, Z],
    ],
    ['a vertical rule', OPS.stroke, [M, 0, 0, L, 0, 100]],
    ['a diagonal line', OPS.stroke, [M, 0, 0, L, 100, 30]],
    ['a curve', OPS.stroke, [M, 0, 0, C, 10, 1, 20, 1, 30, 0]],
    ['a quadratic curve', OPS.stroke, [M, 0, 0, Q, 15, 0, 30, 0]],
    ['a dot', OPS.stroke, [M, 0, 0, L, 0.2, 0]],
    ['a clipping path', OPS.endPath, [M, 0, 0, L, 100, 0]],
    ['a lone moveTo', OPS.stroke, [M, 0, 0]],
    ['an unknown path opcode', OPS.stroke, [9, 0, 0, 100, 0]],
  ])('ignores %s', (_, paint, data) => {
    expect(segments(path(paint, data))).toEqual([]);
  });

  it('keeps heavy rules and filled bars for judging against the text size', () => {
    expect(
      segments(
        [OPS.setLineWidth, [3]],
        path(OPS.stroke, [M, 0, 0, L, 100, 0]),
        path(OPS.fill, [M, 0, 10, L, 100, 10, L, 100, 22, L, 0, 22, Z]),
      ).map((segment) => segment.thickness),
    ).toEqual([3, 12]);
  });

  it('counts the stroke of a filled and stroked bar toward its thickness', () => {
    const bar = [M, 0, 0, L, 50, 0, L, 50, 0.6, L, 0, 0.6, Z];
    expect(
      segments([OPS.setLineWidth, [1]], path(OPS.fillStroke, bar)),
    ).toEqual([
      {
        x0: 0,
        x1: 50,
        y: expect.closeTo(0.3, 5) as number,
        thickness: expect.closeTo(1.6, 5) as number,
      },
    ]);
  });

  it('treats an outline whose fill is invisible as an outline', () => {
    const box = [M, 0, 0, L, 100, 0, L, 100, 12, L, 0, 12, Z];
    expect(
      segments([OPS.setFillRGBColor, ['#ffffff']], path(OPS.fillStroke, box)),
    ).toEqual([]);
  });

  it('applies and then pops a form XObject matrix', () => {
    const [inside, after] = segments(
      [
        OPS.paintFormXObjectBegin,
        [
          [1, 0, 0, 1, 0, 300],
          [0, 0, 100, 100],
        ],
      ],
      path(OPS.stroke, [M, 0, 0, L, 10, 0]),
      [OPS.paintFormXObjectEnd, null],
      path(OPS.stroke, [M, 0, 0, L, 10, 0]),
    );
    expect(inside?.y).toBe(300);
    expect(after?.y).toBe(0);
    expect(
      segments(
        [OPS.paintFormXObjectBegin, [null, null]],
        path(OPS.stroke, [M, 0, 7, L, 10, 7]),
      )[0]?.y,
    ).toBe(7);
  });

  it('skips malformed operator arguments instead of throwing', () => {
    expect(
      segments(
        [OPS.restore, null],
        [OPS.transform, ['a']],
        [OPS.setLineWidth, []],
        [OPS.constructPath, [OPS.stroke]],
        path(OPS.stroke, [M, 0, 0, L, 10, 0]),
      ),
    ).toEqual([{ x0: 0, x1: 10, y: 0, thickness: 1 }]);
  });
});

describe('collectGlyphWidths', () => {
  it('records advance widths per font from text-showing operators', () => {
    const widths = collectGlyphWidths(
      ...ops(
        [OPS.showText, [[{ unicode: 'x', width: 999 }]]],
        [OPS.setFont, ['f1', 10]],
        [
          OPS.showText,
          [[{ unicode: 'i', width: 278 }, -12, { unicode: 'm', width: 778 }]],
        ],
        [OPS.setFont, ['f2', 12]],
        [
          OPS.showText,
          [
            [
              { unicode: 'i', width: 600 },
              { unicode: ' ', width: 0 },
            ],
          ],
        ],
        [OPS.setFont, [7]],
        [OPS.showText, [['bad']]],
      ),
      OPS,
    );
    expect(widths.get('f1')).toEqual(
      new Map([
        ['i', 278],
        ['m', 778],
      ]),
    );
    expect(widths.get('f2')).toEqual(new Map([['i', 600]]));
  });
});

describe('glyphExtents', () => {
  const widths: GlyphWidths = new Map([
    [
      'f1',
      new Map([
        ['i', 250],
        ['m', 750],
      ]),
    ],
  ]);

  it('splits an item at proportional glyph boundaries scaled to its width', () => {
    expect(glyphExtents(item({ text: 'mi', x: 0, width: 10 }), widths)).toEqual(
      [
        [0, 7.5],
        [7.5, 10],
      ],
    );
  });

  it('gives unknown characters the font average, and equal widths with no font data', () => {
    expect(
      glyphExtents(item({ text: 'iz', x: 0, width: 7.5 }), widths),
    ).toEqual([
      [0, 2.5],
      [2.5, 7.5],
    ]);
    expect(
      glyphExtents(
        item({ text: 'abc', x: 0, width: 9, fontName: 'none' }),
        noWidths,
      ),
    ).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
    ]);
  });

  it('gives both halves of a surrogate pair the same glyph box', () => {
    expect(
      glyphExtents(item({ text: 'a😀', x: 0, width: 4 }), noWidths),
    ).toEqual([
      [0, 2],
      [2, 4],
      [2, 4],
    ]);
  });

  it('collapses a zero-width item to its origin', () => {
    expect(glyphExtents(item({ text: '', width: 0 }), noWidths)).toEqual([]);
  });
});

describe('markLine', () => {
  const strike = (x0: number, x1: number, y = 503): MarkSegment => ({
    x0,
    x1,
    y,
    thickness: 0.6,
  });
  const under = (x0: number, x1: number): MarkSegment => strike(x0, x1, 499);

  it('marks a whole item that a strike or underline covers', () => {
    const items = [
      item({ text: 'old', x: 100, width: 30 }),
      item({ text: 'new', x: 135, width: 30 }),
    ];
    const marks = markLine(
      items,
      [strike(100, 130), under(135, 165)],
      noWidths,
    );
    expect(marks).toEqual({
      statuses: [
        ['deleted', 'deleted', 'deleted'],
        ['inserted', 'inserted', 'inserted'],
      ],
      issues: new Set(),
    });
  });

  it('marks only the covered glyphs of a merged run', () => {
    const merged = item({ text: 'keep drop keep', x: 0, width: 140 });
    const marks = markLine([merged], [strike(50, 90)], noWidths);
    expect(marks.statuses[0]?.join(',')).toBe(
      Array.from('keep drop keep')
        .map((_, index) => (index >= 5 && index < 9 ? 'deleted' : 'unchanged'))
        .join(','),
    );
  });

  it(`requires ${String(GEOMETRY.minGlyphCoverage * 100)}% of a glyph to be covered`, () => {
    const glyph = item({ text: 'x', x: 0, width: 10 });
    expect(markLine([glyph], [strike(0, 7.1)], noWidths).statuses).toEqual([
      ['deleted'],
    ]);
    expect(markLine([glyph], [strike(0, 6.9)], noWidths).statuses).toEqual([
      ['unchanged'],
    ]);
    // Two touching rules are one covered stretch, not double-counted.
    expect(
      markLine([glyph], [strike(0, 4), strike(3, 7.5)], noWidths).statuses,
    ).toEqual([['deleted']]);
  });

  it('reports glyphs both struck and underlined as deleted, and flags the conflict', () => {
    const marks = markLine(
      [item({ text: 'ab', x: 0, width: 20 })],
      [strike(0, 20), under(0, 20)],
      noWidths,
    );
    expect(marks.statuses).toEqual([['deleted', 'deleted']]);
    expect(marks.issues).toEqual(new Set(['conflict', 'whole-line']));
  });

  it('leaves text unchanged under a rule between the bands, and flags it', () => {
    const marks = markLine(
      [item({ text: 'ab', x: 0, width: 20 })],
      [strike(0, 20, 500.9)],
      noWidths,
    );
    expect(marks).toEqual({
      statuses: [['unchanged', 'unchanged']],
      issues: new Set(['ambiguous']),
    });
  });

  it('does not flag an ambiguous rule that only crosses whitespace', () => {
    expect(
      markLine(
        [item({ text: 'a b', x: 0, width: 30 })],
        [strike(11, 19, 500.9)],
        noWidths,
      ).issues.size,
    ).toBe(0);
  });

  it('ignores a rule that overhangs the line text like a table rule', () => {
    const line = [item({ text: 'Fee schedule', x: 100, width: 60 })];
    expect(
      markLine(line, [strike(70, 230)], noWidths).statuses[0],
    ).not.toContain('deleted');
    // A run-on over one trailing space (Ohio) is within the allowance.
    expect(markLine(line, [under(100, 166.3)], noWidths).statuses[0]).toEqual(
      Array.from('Fee schedule', () => 'inserted'),
    );
  });

  it('ignores rules that do not overlap the text, and handles an empty line', () => {
    const line = [item({ text: 'Fees', x: 100, width: 20 })];
    expect(
      markLine(line, [strike(124, 184), under(40, 99)], noWidths).statuses,
    ).toEqual([['unchanged', 'unchanged', 'unchanged', 'unchanged']]);
    expect(markLine([], [strike(0, 10)], noWidths)).toEqual({
      statuses: [],
      issues: new Set(),
    });
  });
});

describe('visible paint (review finding 2)', () => {
  const rule = path(OPS.stroke, [M, 0, 10, L, 50, 10]);
  const bar = path(OPS.fill, [M, 0, 0, L, 50, 0, L, 50, 0.6, L, 0, 0.6, Z]);

  it.each([
    ['a white cover-up rectangle', [[OPS.setFillRGBColor, ['#ffffff']], bar]],
    [
      'a near-white (5% grey) rule',
      [[OPS.setStrokeRGBColor, ['#f2f2f2']], rule],
    ],
    ['a fully transparent fill', [[OPS.setGState, [[['ca', 0]]]], bar]],
    ['a fully transparent stroke', [[OPS.setGState, [[['CA', 0]]]], rule]],
    ['black at 5% opacity', [[OPS.setGState, [[['CA', 0.05]]]], rule]],
  ] as [string, [number, unknown][]][])('ignores %s', (_, entries) => {
    expect(segments(...entries)).toEqual([]);
  });

  it.each([
    ['blue', [[OPS.setStrokeRGBColor, ['#0000ff']], rule]],
    [
      'yellow (dark in one channel)',
      [[OPS.setStrokeRGBColor, ['#ffff00']], rule],
    ],
    [
      'CMYK black at half opacity',
      [
        [OPS.setGState, [[['CA', 0.5]]]],
        [OPS.setStrokeRGBColor, ['#2c2e35']],
        rule,
      ],
    ],
    [
      'a pattern fill',
      [
        [OPS.setFillRGBColor, ['#ffffff']],
        [OPS.setFillColorN, ['TilingPattern']],
        bar,
      ],
    ],
    [
      'a pattern stroke',
      [
        [OPS.setStrokeRGBColor, ['#ffffff']],
        [OPS.setStrokeColorN, ['TilingPattern']],
        rule,
      ],
    ],
  ] as [string, [number, unknown][]][])('keeps %s', (_, entries) => {
    expect(segments(...entries)).toHaveLength(1);
  });

  it('restores paint with the graphics state and reads line width from a graphics state', () => {
    expect(
      segments(
        [OPS.save, null],
        [OPS.setStrokeRGBColor, ['#ffffff']],
        [OPS.restore, null],
        [
          OPS.setGState,
          [
            [
              ['LW', 0.4],
              ['BM', 'Normal'],
              ['CA', 'bad'],
            ],
          ],
        ],
        rule,
      ),
    ).toEqual([
      { x0: 0, x1: 50, y: 10, thickness: expect.closeTo(0.4, 5) as number },
    ]);
  });

  it('skips malformed colour and graphics-state arguments', () => {
    expect(
      segments(
        [OPS.setStrokeRGBColor, ['white']],
        [OPS.setGState, ['bad']],
        rule,
      ),
    ).toHaveLength(1);
  });
});

describe('withoutLinkUnderlines (review finding 3)', () => {
  const link = { x0: 100, y0: 497, x1: 140, y1: 508 };
  const at = (y: number, x0 = 100, x1 = 140): MarkSegment => ({
    x0,
    x1,
    y,
    thickness: 0.5,
  });

  it('drops an underline along the bottom of a hyperlink, and keeps a strike through it', () => {
    expect(
      withoutLinkUnderlines(
        [at(498.5), at(502.6), at(498.5, 200, 240)],
        [link],
      ),
    ).toEqual([at(502.6), at(498.5, 200, 240)]);
  });

  it('keeps a rule that only grazes the link area', () => {
    expect(withoutLinkUnderlines([at(498.5, 130, 200)], [link])).toHaveLength(
      1,
    );
    expect(withoutLinkUnderlines([at(490)], [link])).toHaveLength(1);
  });
});

describe('thickness relative to the text (review finding 1)', () => {
  const big = item({ text: 'word', x: 0, width: 115.2, y: 700, fontSize: 48 });
  const rule = (thickness: number, y = 714.4): MarkSegment => ({
    x0: 0,
    x1: 115.2,
    y,
    thickness,
  });

  it('caps a mark at max(1.5pt, 0.15em)', () => {
    expect(maxMarkThickness(10)).toBe(1.5);
    expect(maxMarkThickness(12)).toBeCloseTo(1.8);
    expect(maxMarkThickness(48)).toBeCloseTo(7.2);
  });

  it('reads a 3pt strike through 48pt text as a strikethrough', () => {
    expect(markLine([big], [rule(3)], noWidths).statuses[0]).toEqual(
      Array.from('word', () => 'deleted'),
    );
  });

  it('reads a filled and stroked 1.6pt bar through 12pt text as a strikethrough', () => {
    const text = item({ text: 'brown', x: 0, width: 36, y: 700, fontSize: 12 });
    expect(
      markLine([text], [{ x0: 0, x1: 36, y: 703.6, thickness: 1.6 }], noWidths)
        .statuses[0],
    ).toEqual(Array.from('brown', () => 'deleted'));
  });

  it('flags an in-band rule too heavy to be a mark, and leaves the text unchanged', () => {
    const text = item({ text: 'brown', x: 0, width: 50, y: 700, fontSize: 10 });
    const heavy = { x0: 0, x1: 50, y: 703, thickness: 3 };
    expect(markLine([text], [heavy], noWidths)).toEqual({
      statuses: [Array.from('brown', () => 'unchanged')],
      issues: new Set(['too-thick']),
    });
  });

  it('ignores a highlight or box thicker than half an em, silently', () => {
    expect(markLine([big], [rule(30, 712)], noWidths)).toEqual({
      statuses: [Array.from('word', () => 'unchanged')],
      issues: new Set(),
    });
  });

  it('flags an in-band hairline instead of marking the line', () => {
    const line = item({
      text: 'Section 1. The quick',
      x: 72,
      width: 144,
      y: 700,
      fontSize: 12,
    });
    expect(
      markLine(
        [line],
        [{ x0: 72, x1: 216, y: 703.6, thickness: 0.1 }],
        noWidths,
      ),
    ).toEqual({
      statuses: [Array.from('Section 1. The quick', () => 'unchanged')],
      issues: new Set(['hairline']),
    });
  });
});

describe('whole-line rules (review finding 3)', () => {
  const words = [
    item({ text: 'Fee', x: 100, width: 18 }),
    item({ text: 'table', x: 124, width: 30 }),
  ];
  const rule = (x0: number, x1: number): MarkSegment => ({
    x0,
    x1,
    y: 497.5,
    thickness: 0.5,
  });

  it('notes when one rule marks every glyph on the line', () => {
    expect(markLine(words, [rule(100, 154)], noWidths).issues).toEqual(
      new Set(['whole-line']),
    );
  });

  it('does not note rules that each mark only part of the line', () => {
    expect(
      markLine(words, [rule(100, 118), rule(124, 154)], noWidths).issues,
    ).toEqual(new Set());
  });
});

describe('skewed baselines', () => {
  it('lineY is the same along a rising baseline, and baselineAt follows it', () => {
    const start = item({ x: 40, y: 500.4, slope: 0.01 });
    const far = item({ x: 540, y: 505.4, slope: 0.01 });
    expect(lineY(start)).toBeCloseTo(lineY(far));
    expect(baselineAt(start, 540)).toBeCloseTo(505.4);
    expect(lineY(item({ x: 40, y: 500 }))).toBe(500);
    expect(baselineAt(item({ x: 40, y: 500 }), 400)).toBe(500);
  });

  it('judges a level rule against the baseline at the rule, not at the item start', () => {
    // Over 400pt the baseline climbs 4pt, 0.4em at 10pt: a level strike at the far end of the
    // line sits 4pt above the baseline at the start and would read as outside the strike band.
    const text = item({ x: 100, y: 500, slope: 0.01, width: 400 });
    const strike: MarkSegment = {
      x0: 450,
      x1: 490,
      y: 504.7 + 3,
      thickness: 0.6,
    };
    const { statuses } = markLine([text], [strike], noWidths);
    expect(statuses[0]?.some((status) => status === 'deleted')).toBe(true);
    const flat = markLine([{ ...text, slope: 0 }], [strike], noWidths);
    expect(flat.statuses[0]?.some((status) => status === 'deleted')).toBe(
      false,
    );
  });
});
