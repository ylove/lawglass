import { expect, test } from 'vitest';
import { jurisdictionSections, newYorkMetadata } from './new-york.js';
import { parseHtml } from './html.js';
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
