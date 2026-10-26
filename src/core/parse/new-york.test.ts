import { expect, test } from 'vitest';
import { jurisdictionSections, newYorkMetadata } from './new-york.js';
import { parseHtml } from './html.js';
import { parseText as parseTextNy } from './text.js';
import { bracketText, NY_LEGEND } from '../../../tests/synth/brackets.js';
import { walkSections } from '../model/index.js';
const context = {
  sourceUrl: 'https://nyassembly.gov/leg/?bn=S4321&term=2025&Text=Y',
  fetchedAt: '2026-10-25T00:00:00.000Z',
};
test('NY metadata is deterministic and read from the printed title block', () => {
  expect(newYorkMetadata(bracketText(), context)).toMatchObject({
    title:
      'AN ACT to amend the public health law, in relation to sample notices',
    billNumber: 'S. 4321A',
    session: '2025-2026 Regular Sessions',
    version: 'Amended (A)',
    jurisdiction: 'New York',
    sponsors: ['EXAMPLE'],
    source: 'structured',
  });
  expect(
    newYorkMetadata(
      'STATE OF NEW YORK\n1234--B\nIN ASSEMBLY\nIntroduced by M. of A. EXAMPLE, SAMPLE -- printed',
      context,
    ),
  ).toMatchObject({
    billNumber: 'A. 1234B',
    version: 'Amended (B)',
    sponsors: ['EXAMPLE', 'SAMPLE'],
  });
  expect(
    newYorkMetadata('Unidentified bill', { sourceUrl: 'https://example.gov' })
      .source,
  ).toBe('none');
  expect(newYorkMetadata('STATE OF NEW YORK', context)).toMatchObject({
    billNumber: null,
    version: null,
    sponsors: null,
  });
});
test('jurisdiction-specific section patterns do not change other jurisdictions or override explicit patterns', () => {
  expect(
    jurisdictionSections({ sourceUrl: 'https://ohio.gov' }).patterns,
  ).toBeUndefined();
  expect(jurisdictionSections({ ...context, patterns: [] }).patterns).toEqual(
    [],
  );
});
test('Assembly text is isolated from summary, navigation and memos and fixed printed gutters', () => {
  const doc = parseHtml(
    `<nav>Menus</nav><h3>Summary</h3><p>Other words</p><h3 id="jump_to_Text">Text</h3><pre>STATE OF NEW YORK\n4321--A\nIN SENATE\n${NY_LEGEND}\n     1    Section 1. A notice [old] <u>new</u>.\n     2    1. Detail.\n     3    (a) Paragraph.\n     4    (i) Subparagraph.\n        S. 4321--A                         2\n     1    § 2. Effective date.\n LBD00000-00-0</pre><h3>Memo</h3><pre>Ignore this memo</pre>`,
    context,
  );
  const sections = [...walkSections(doc.sections)];
  const text = sections
    .flatMap((s) => s.spans)
    .map((s) => s.text)
    .join('');
  expect(text).not.toMatch(
    /Menus|Other words|Ignore this memo|LBD00000|S\. 4321--A/,
  );
  expect(sections.map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-1/1',
    'sec-1/1/a',
    'sec-1/1/a/i',
    'sec-2',
  ]);
  expect(doc.metadata).toMatchObject({
    billNumber: 'S. 4321A',
    version: 'Amended (A)',
  });
});
test('fails clearly if the Assembly text heading has no text', () => {
  expect(() => parseHtml('<h3 id="jump_to_Text">Text</h3>', context)).toThrow(
    /no full bill text/,
  );
});

test('refuses an Assembly summary or error response without the text block', () => {
  expect(() =>
    parseHtml('<h3>Summary</h3><p>Bill not found</p>', context),
  ).toThrow(/no full bill text/);
});

test.each([
  'Section 1. STATE OF NEW YORK, COUNTY OF KINGS. A notary jurat.',
  'A federal bill.\n' +
    'Federal provisions. '.repeat(180) +
    '\nSTATE OF NEW YORK\nIN SENATE\n' +
    NY_LEGEND,
  'STATE OF NEW YORK\nIN SENATE\nSection 1. No legend.',
  'STATE OF NEW YORK\n' + NY_LEGEND + '\nSection 1. No chamber header.',
])('does not label federal prose as a structured NY bill: %s', (text) => {
  expect(
    newYorkMetadata(text, { sourceUrl: 'https://www.congress.gov/bill' }),
  ).toMatchObject({ jurisdiction: null, source: 'none' });
  expect(
    newYorkMetadata(text, { sourceUrl: 'https://www.congress.gov/bill' })
      .docKind,
  ).toBeUndefined();
});

test('recognizes a mirrored NY bill only from its opening state/chamber header and full legend', () => {
  expect(
    newYorkMetadata(
      bracketText().replace('S. 4321--A', 'S. 4321--A\nIN SENATE'),
      { sourceUrl: 'https://example.gov/bill' },
    ),
  ).toMatchObject({
    jurisdiction: 'New York',
    billNumber: 'S. 4321A',
    source: 'structured',
  });
});

const a5000Shape = [
  'STATE OF NEW YORK',
  'Section 1. Short Title. This act shall be known and may be cited as',
  'the "example act".',
  '§ 2. Legislative Findings. The legislature finds that',
  '1. Something is true.',
  '§ 3. Subdivision 3 of section 198 of the labor law, as amended by',
  'chapter 397 of the laws of 2021, is amended to read as follows:',
  '3. Notwithstanding any other provision of law, an employer pays.',
  '§ 4. Subdivision 1 of section 663 of the labor law, as amended by',
  'chapter 564 of the laws of 2010, is amended to read as follows:',
  'article 6 of the labor law is amended.',
  '§ 424-c. A quoted statute number is text, not a bill section.',
  '§ 5. This act shall take effect immediately.',
].join('\n');

test('NY bills have only their own sections as containers; wrapped "chapter N of the laws" lines are prose', async () => {
  const { parseText } = await import('./text.js');
  const doc = parseText(new TextEncoder().encode(a5000Shape), context);
  const ids = [...walkSections(doc.sections)].map((s) => s.id);
  expect(doc.sections.map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-2',
    'sec-3',
    'sec-4',
    'sec-5',
  ]);
  expect(ids.some((id) => id.startsWith('chapter-'))).toBe(false);
  expect(ids.some((id) => id.startsWith('article-'))).toBe(false);
  // A quoted statute number is a container inside its bill section, not a bill section.
  expect(ids).toContain('sec-4/424-c');
  const headings = new Map(
    [...walkSections(doc.sections)].map((s) => [s.id, s.heading]),
  );
  expect(headings.get('sec-1')).toBe('Short Title.');
  expect(headings.get('sec-2')).toBe('Legislative Findings.');
  expect(headings.get('sec-3')).toBeUndefined();
  expect(headings.get('sec-5')).toBeUndefined();
});

const ids = (text: string) =>
  [...walkSections(parseTextNy(text, context).sections)].map((s) => s.id);

test('NY: a quoted statute section colliding with the next bill number does not replace the real section', () => {
  expect(
    ids(
      [
        'STATE OF NEW YORK',
        'Section 1. Section 3 of the general municipal law is amended to read as follows:',
        '§ 3. Definitions. As used in this article:',
        '1. "Board" means the board.',
        '§ 2. Section 4 of the general municipal law is amended to read as follows:',
        '§ 4. Powers. The board may adopt rules.',
        '§ 3. This act shall take effect immediately.',
      ].join('\n'),
    ),
  ).toEqual([
    'preamble',
    'sec-1',
    'sec-1/3',
    'sec-1/3/1',
    'sec-2',
    'sec-2/4',
    'sec-3',
  ]);
});

test('NY: § 1-a. follows § 1 and numbering restarts at each PART', () => {
  expect(
    ids(
      [
        'STATE OF NEW YORK',
        'Section 1. Short title. A.',
        '§ 1-a. Findings. B.',
        '§ 2. Effective date. C.',
        'PART B',
        'Section 1. Part B title. D.',
        '§ 2. Severability. If any clause is invalid, the rest stands.',
      ].join('\n'),
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1-a', 'sec-2', 'sec-1~2', 'sec-2~2']);
});

test('NY: subdivisions of a quoted § stay under that container', () => {
  expect(
    ids(
      [
        'STATE OF NEW YORK',
        'Section 1. The general business law is amended by adding a new article to read as follows:',
        '§ 1509. Definitions. For the purposes of this article:',
        '1. "A" means a.',
        '2. "B" means b.',
        '§ 1510. Duty.',
        '1. Do it.',
        '§ 2. This act shall take effect immediately.',
      ].join('\n'),
    ),
  ).toEqual([
    'preamble',
    'sec-1',
    'sec-1/1509',
    'sec-1/1509/1',
    'sec-1/1509/2',
    'sec-1/1510',
    'sec-1/1510/1',
    'sec-2',
  ]);
});

const withLegend = (...lines: string[]) =>
  ['STATE OF NEW YORK', NY_LEGEND, ...lines].join('\n');

test('NY: a quoted "§ N. This act shall take effect" with change marks is not a bill section', () => {
  // The sunset-extender shape (A7601, A9492, S3260): the amended law ends with its own
  // effective-date section, which carries the bracketed old date.
  expect(
    ids(
      withLegend(
        'Section 1. Section 3 of chapter 383 of the laws of 1991 is amended to read as follows:',
        '§ 3. This act shall take effect immediately, provided, however, that',
        'section two of this act shall take effect December 31, [2025] 2030.',
        '§ 2. This act shall take effect immediately.',
      ),
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/3', 'sec-2']);
});

test('NY: "read as follows" on the fourth line still marks the quote', () => {
  expect(
    ids(
      withLegend(
        'Section 1. Sections 3, 4, 5, 6, 7, 8 and 9 of chapter 18 of the laws',
        'of 1991, relating to the thing, as amended by chapter 4 of the laws',
        'of 2020, are amended to',
        'read as follows:',
        '§ 3. First.',
        '§ 4. Second.',
        '§ 5. Third.',
        '§ 2. Real second section amends the code. The code is amended.',
        '§ 3. This act shall take effect immediately.',
      ),
    ),
  ).toEqual([
    'preamble',
    'sec-1',
    'sec-1/3',
    'sec-1/4',
    'sec-1/5',
    'sec-2',
    'sec-3',
  ]);
});

test('NY: a hyphenated section reference never names a bill section number', () => {
  // "section 2-204" is the administrative code's, not a quoted "2": the bill's own section 2
  // opens with its verb on the third line and must still be section 2.
  expect(
    ids(
      withLegend(
        'Section 1. Section 2-204 of the administrative code is amended to read as follows:',
        '§ 2-204. Rules. The commissioner may adopt rules.',
        '§ 2. Subdivision j of section 19-506 of such code',
        'as amended by chapter 4 of the laws of 2020,',
        'is amended to read as follows:',
      ),
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/2-204', 'sec-2']);
});

test('NY: "adding a new section 3" names the quoted number', () => {
  expect(
    ids(
      withLegend(
        'Section 1. The general municipal law is amended by adding a new section 3 to read as follows:',
        '§ 3. Definitions. As used in this article:',
        '§ 2. This act shall take effect immediately.',
      ),
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/3', 'sec-2']);
});

test("NY: PART bills lead each restarted section's heading with its part", () => {
  const doc = parseTextNy(
    [
      'STATE OF NEW YORK',
      'PART A',
      'Section 1. Short title. A.',
      'PART B',
      'Section 1. Part B title. D.',
      '§ 2. Severability. If any clause is invalid, the rest stands.',
    ].join('\n'),
    context,
  );
  expect([...walkSections(doc.sections)].map((s) => [s.id, s.heading])).toEqual(
    [
      ['preamble', undefined],
      ['sec-1', 'Part A. Short title.'],
      ['sec-1~2', 'Part B. Part B title.'],
      ['sec-2', 'Part B. Severability.'],
    ],
  );
});
