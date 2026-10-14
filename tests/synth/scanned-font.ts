/**
 * A tiny 5x7 bitmap font for the scanned-page generator (no canvas, no native deps).
 *
 * Glyph rows are strings of `#` (ink) and `.`. A glyph is `"<top>:<row>/<row>/..."`,
 * where `top` is the cell row of its first line. Cell rows are numbered from the top
 * of the capital letters:
 *
 *   rows 0-1  ascender zone (b d f h k l t, capitals, digits start at 0)
 *   rows 2-6  x-height zone (lowercase bodies); row 4 is the middle, where an "e"
 *             crossbar and a hyphen sit -- the same height a strike-through uses
 *   row 7-8   descender zone (g j p q y); the baseline is the line between rows 6 and 7
 */

const GLYPH_SOURCE: Record<string, string> = {
  A: '0:.###./#...#/#...#/#####/#...#/#...#/#...#',
  B: '0:####./#...#/#...#/####./#...#/#...#/####.',
  C: '0:.###./#...#/#..../#..../#..../#...#/.###.',
  D: '0:####./#...#/#...#/#...#/#...#/#...#/####.',
  E: '0:#####/#..../#..../####./#..../#..../#####',
  F: '0:#####/#..../#..../####./#..../#..../#....',
  G: '0:.###./#...#/#..../#.###/#...#/#...#/.###.',
  H: '0:#...#/#...#/#...#/#####/#...#/#...#/#...#',
  I: '0:.###./..#../..#../..#../..#../..#../.###.',
  J: '0:..###/...#./...#./...#./...#./#..#./.##..',
  K: '0:#...#/#..#./#.#../##.../#.#../#..#./#...#',
  L: '0:#..../#..../#..../#..../#..../#..../#####',
  M: '0:#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#',
  N: '0:#...#/##..#/#.#.#/#..##/#...#/#...#/#...#',
  O: '0:.###./#...#/#...#/#...#/#...#/#...#/.###.',
  P: '0:####./#...#/#...#/####./#..../#..../#....',
  Q: '0:.###./#...#/#...#/#...#/#.#.#/#..#./.##.#',
  R: '0:####./#...#/#...#/####./#.#../#..#./#...#',
  S: '0:.####/#..../#..../.###./....#/....#/####.',
  T: '0:#####/..#../..#../..#../..#../..#../..#..',
  U: '0:#...#/#...#/#...#/#...#/#...#/#...#/.###.',
  V: '0:#...#/#...#/#...#/#...#/#...#/.#.#./..#..',
  W: '0:#...#/#...#/#...#/#.#.#/#.#.#/##.##/#...#',
  X: '0:#...#/#...#/.#.#./..#../.#.#./#...#/#...#',
  Y: '0:#...#/#...#/.#.#./..#../..#../..#../..#..',
  Z: '0:#####/....#/...#./..#../.#.../#..../#####',
  a: '2:.###./....#/.####/#...#/.####',
  b: '0:#..../#..../####./#...#/#...#/#...#/####.',
  c: '2:.###./#...#/#..../#...#/.###.',
  d: '0:....#/....#/.####/#...#/#...#/#...#/.####',
  e: '2:.###./#...#/#####/#..../.####',
  f: '0:..##./.#..#/.#.../###../.#.../.#.../.#...',
  g: '2:.####/#...#/#...#/.####/....#/#...#/.###.',
  h: '0:#..../#..../####./#...#/#...#/#...#/#...#',
  i: '0:..#../...../.##../..#../..#../..#../.###.',
  j: '0:...#./...../..##./...#./...#./...#./...#./#..#./.##..',
  k: '0:#..../#..../#..#./#.#../##.../#.#../#..#.',
  l: '0:.##../..#../..#../..#../..#../..#../.###.',
  m: '2:##.#./#.#.#/#.#.#/#.#.#/#.#.#',
  n: '2:####./#...#/#...#/#...#/#...#',
  o: '2:.###./#...#/#...#/#...#/.###.',
  p: '2:####./#...#/#...#/####./#..../#..../#....',
  q: '2:.####/#...#/#...#/.####/....#/....#/....#',
  r: '2:#.##./##..#/#..../#..../#....',
  s: '2:.####/#..../.###./....#/####.',
  t: '0:.#.../.#.../###../.#.../.#.../.#..#/..##.',
  u: '2:#...#/#...#/#...#/#...#/.####',
  v: '2:#...#/#...#/#...#/.#.#./..#..',
  w: '2:#...#/#...#/#.#.#/#.#.#/.#.#.',
  x: '2:#...#/.#.#./..#../.#.#./#...#',
  y: '2:#...#/#...#/#...#/.####/....#/#...#/.###.',
  z: '2:#####/...#./..#../.#.../#####',
  '0': '0:.###./#...#/#..##/#.#.#/##..#/#...#/.###.',
  '1': '0:..#../.##../..#../..#../..#../..#../.###.',
  '2': '0:.###./#...#/....#/...#./..#../.#.../#####',
  '3': '0:####./....#/....#/.###./....#/....#/####.',
  '4': '0:...#./..##./.#.#./#..#./#####/...#./...#.',
  '5': '0:#####/#..../####./....#/....#/#...#/.###.',
  '6': '0:.###./#..../#..../####./#...#/#...#/.###.',
  '7': '0:#####/....#/...#./..#../.#.../.#.../.#...',
  '8': '0:.###./#...#/#...#/.###./#...#/#...#/.###.',
  '9': '0:.###./#...#/#...#/.####/....#/....#/.###.',
  '.': '6:..#..',
  ',': '6:..#../.#...',
  ';': '3:..#../...../...../..#../.#...',
  ':': '3:..#../...../...../..#..',
  '!': '0:..#../..#../..#../..#../..#../...../..#..',
  '?': '0:.###./#...#/....#/...#./..#../...../..#..',
  "'": '0:..#../..#../.#...',
  '"': '0:.#.#./.#.#./.#.#.',
  '(': '0:...#./..#../.#.../.#.../.#.../..#../...#.',
  ')': '0:.#.../..#../...#./...#./...#./..#../.#...',
  '/': '0:....#/....#/...#./..#../.#.../#..../#....',
  // Hyphen, en dash and em dash all sit on row 4, the x-height midline. They are the
  // classic false positives for a strike detector.
  '-': '4:.###.',
  '–': '4:#####',
  '—': '4:#######',
};

export interface Glyph {
  /** Cell row of the first ink row (see the file comment). */
  top: number;
  /** Columns, so em dash can be wider than a letter. */
  width: number;
  rows: string[];
}

function parseGlyph(source: string): Glyph {
  const colon = source.indexOf(':');
  const rows = source.slice(colon + 1).split('/');
  return {
    top: Number(source.slice(0, colon)),
    width: rows[0]?.length ?? 0,
    rows,
  };
}

const GLYPHS = new Map<string, Glyph>(
  Object.entries(GLYPH_SOURCE).map(([char, source]) => [
    char,
    parseGlyph(source),
  ]),
);

/** Cell rows above the baseline: capital height. */
export const CAP_ROWS = 7;
/** Cell rows from the top of the capitals to the bottom of descenders. */
export const TOTAL_ROWS = 9;
/** Cell row where the x-height zone starts. */
export const X_HEIGHT_TOP_ROW = 2;

export function glyphFor(char: string): Glyph {
  const glyph = GLYPHS.get(char);
  if (!glyph) {
    throw new Error(
      `Scanned-page font has no glyph for ${JSON.stringify(char)}`,
    );
  }
  return glyph;
}

export function isSupportedChar(char: string): boolean {
  return GLYPHS.has(char);
}

/** Advance of one glyph in cells, including a one-cell gap after it. */
export function glyphAdvance(char: string): number {
  return glyphFor(char).width + 1;
}

/** Visible width of a word in cells (no trailing gap). */
export function wordWidthCells(text: string): number {
  let total = 0;
  for (const char of text) total += glyphAdvance(char);
  return total - 1;
}

/** Ink cells of a glyph as `[column, row]` pairs, rows measured from the top of the capitals. */
export function inkCells(char: string): [number, number][] {
  const glyph = glyphFor(char);
  const cells: [number, number][] = [];
  glyph.rows.forEach((row, index) => {
    for (let column = 0; column < row.length; column += 1) {
      if (row[column] === '#') cells.push([column, glyph.top + index]);
    }
  });
  return cells;
}
