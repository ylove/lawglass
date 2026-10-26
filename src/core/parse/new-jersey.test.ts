import { expect, test } from 'vitest';
import { newJerseyMetadata } from './new-jersey.js';
import { parseText } from './text.js';
import { parseHtml } from './html.js';
import { NJ_LEGEND } from '../../../tests/synth/brackets.js';
import { sectionText, walkSections } from '../model/index.js';

// Built with URL so the host is never a bare string literal that reads like a pattern.
const njUrl = new URL('/Bills/2024/S1000/1000_R1.PDF', 'https://pub.njleg.gov')
  .href;
const mirror = new URL('/bill', 'https://example.gov').href;
const context = { sourceUrl: njUrl, fetchedAt: '2026-10-26T00:00:00.000Z' };

const cover = [
  '[First Reprint]',
  'SENATE, No. 1000',
  'STATE OF NEW JERSEY',
  '221st LEGISLATURE',
  'PRE-FILED FOR INTRODUCTION IN THE 2024 SESSION',
  'Sponsored by:',
  'Senator LINDA R. GREENSTEIN',
  'District 14 (Mercer and Middlesex)',
  'Assemblywoman JANE Q. PUBLIC',
  'Co-Sponsored by:',
  'Senators Pou and Diegnan',
  'SYNOPSIS',
  'Requires a designation.',
  'S1000 [1R] GREENSTEIN',
  'AN ACT concerning a designation indicating the registrant is [deaf]',
  'hard of hearing and amending R.S.39:3-1.',
  'BE IT ENACTED by the Senate and General Assembly of the State',
  'of New Jersey:',
].join('\n');

const bill = [
  cover,
  '1. R.S.39:3-1 is amended to read as follows:',
  '39:3-1. Definitions.',
  'Each person shall apply [of a] to the commission.',
  'b. The commission shall:',
  '(1) issue a certificate to a person who:',
  '(a) is at least 18 years of age;',
  '(b) has completed a course that:',
  '(i) meets weekly; and',
  '(ii) covers these topics;',
  '(c) pays a fee.',
  '(2) maintain records.',
  'c. The commission shall report.',
  '2. This act shall take effect immediately.',
  'STATEMENT',
  'This bill requires a designation.',
  NJ_LEGEND,
].join('\n');

test('NJ metadata is read from the printed cover block', () => {
  expect(newJerseyMetadata(bill, context)).toMatchObject({
    title:
      'AN ACT concerning a designation indicating the registrant is hard of hearing and amending R.S.39:3-1.',
    billNumber: 'S. 1000',
    jurisdiction: 'New Jersey',
    session: '221st Legislature',
    version: 'First Reprint',
    sponsors: ['LINDA R. GREENSTEIN', 'JANE Q. PUBLIC'],
    docKind: 'bill',
    source: 'structured',
  });
  expect(
    newJerseyMetadata(bill.replace('[First Reprint]\n', ''), context).version,
  ).toBe('Introduced');
});

test('NJ metadata needs the bill header and either an NJ host or the full legend', () => {
  // A mirror with the full legend is recognized; without it, or without the header, it is not.
  expect(newJerseyMetadata(bill, { sourceUrl: mirror }).jurisdiction).toBe(
    'New Jersey',
  );
  expect(
    newJerseyMetadata(bill.replace(NJ_LEGEND, ''), { sourceUrl: mirror })
      .source,
  ).toBe('none');
  expect(
    newJerseyMetadata(bill.replace('SENATE, No. 1000\n', ''), context).source,
  ).toBe('none');
  expect(
    newJerseyMetadata(bill.replace('STATE OF NEW JERSEY\n', ''), context)
      .source,
  ).toBe('none');
  // A federal document that mentions New Jersey stays empty.
  expect(
    newJerseyMetadata('A notary of the STATE OF NEW JERSEY signed.', {
      sourceUrl: mirror,
    }).source,
  ).toBe('none');
});

test('NJ sections, subsections and nested paragraphs follow the printed numbering', () => {
  const doc = parseText(bill, context);
  expect(doc.sections.map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-2',
    'article-statement',
  ]);
  expect([...walkSections(doc.sections)].map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-1/b',
    'sec-1/b/1',
    'sec-1/b/1/a',
    'sec-1/b/1/b',
    'sec-1/b/1/b/i',
    'sec-1/b/1/b/ii',
    'sec-1/b/1/c',
    'sec-1/b/2',
    'sec-1/c',
    'sec-2',
    'article-statement',
  ]);
  expect(doc.metadata.billNumber).toBe('S. 1000');
});

test('NJ bracketed words are deleted, the [1R] running header and the legend are not text', () => {
  const doc = parseText(bill, context);
  const spans = [...walkSections(doc.sections)].flatMap((s) => s.spans);
  const deleted = spans
    .filter((s) => s.status === 'deleted')
    .map((s) => s.text)
    .join('|');
  expect(deleted.replace(/\n/g, '')).toBe('[deaf]|[of a]');
  const all = [...walkSections(doc.sections)]
    .map((s) => sectionText(s, { includeDeleted: false }))
    .join('\n');
  expect(all).toContain('S1000 [1R] GREENSTEIN');
  expect(all).not.toContain('EXPLANATION');
  expect(all).not.toContain('[of a]');
});

test('wrapped prose that starts with a number or a statute chapter is not a bill section', () => {
  const doc = parseText(
    [
      cover,
      '1. Section 3 of P.L.2019, c.123 (C.52:1-1), as amended by',
      '2. of the laws of 2021, is amended to read as follows:',
      'chapter 397 of the laws is prose.',
      '2. This act shall take effect immediately.',
    ].join('\n'),
    context,
  );
  expect(doc.sections.map((s) => s.id)).toEqual(['preamble', 'sec-1', 'sec-2']);
});

test('NJ HTML without its legend keeps brackets as text and warns', () => {
  const doc = parseHtml(
    '<html><body><p>SENATE, No. 1</p><p>1. Remove <b>[old]</b> <u>new</u> words.</p></body></html>',
    context,
  );
  const spans = [...walkSections(doc.sections)].flatMap((s) => s.spans);
  expect(spans.some((s) => s.status === 'deleted')).toBe(false);
  expect(spans.some((s) => s.status === 'inserted' && s.text === 'new')).toBe(
    true,
  );
  expect(doc.warnings.join(' ')).toMatch(/legend was not found/);
});

const a4Shape = [
  cover,
  '1. Section 2 of P.L.1985, c.222 (C.52:27D-302) is amended to read as follows:',
  '2. The Legislature finds that:',
  'a. The Court ruled.',
  'b. The State can [maximize] act.',
  '2. Section 4 of P.L.1985, c.222 (C.52:27D-304) is amended to read as follows:',
  '4. As used in P.L.1985, c.222:',
  'a. "Council" means the council;',
  'b. "Fund" means the fund.',
  '3. (New section) The agency shall report.',
  '4. This act shall take effect immediately.',
].join('\n');

test('a quoted statute section that collides with the next bill number is a container inside the bill section', () => {
  const doc = parseText(a4Shape, context);
  expect(doc.sections.map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-2',
    'sec-3',
    'sec-4',
  ]);
  expect([...walkSections(doc.sections)].map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-1/2',
    'sec-1/2/a',
    'sec-1/2/b',
    'sec-2',
    'sec-2/4',
    'sec-2/4/a',
    'sec-2/4/b',
    'sec-3',
    'sec-4',
  ]);
});

test('a wrapped "b. of this section" cross-reference is not subsection b', () => {
  const doc = parseText(
    [
      cover,
      '1. R.S.1:1-1 is amended to read as follows:',
      'a. A person who qualifies under subsection',
      'b. of this section shall apply.',
      'b. The commission shall report.',
    ].join('\n'),
    context,
  );
  expect([...walkSections(doc.sections)].map((s) => s.id)).toEqual([
    'preamble',
    'sec-1',
    'sec-1/a',
    'sec-1/b',
  ]);
});

test('the reprint superscript footnote is removed from law text, even mid-sentence', () => {
  const doc = parseText(
    [
      cover,
      '1. A person shall apply through an agency homebuyer',
      'Matter enclosed in superscript numerals has been adopted as follows:',
      'Senate SCU committee amendments adopted January 25, 2024.',
      "Senate amendments adopted in accordance with Governor's",
      'recommendations June 28, 2024.',
      'program to purchase housing.',
      NJ_LEGEND,
    ].join('\n'),
    context,
  );
  const text = [...walkSections(doc.sections)]
    .map((s) => sectionText(s, { includeDeleted: false }))
    .join('\n');
  expect(text).toContain('homebuyer\nprogram to purchase housing.');
  expect(text).not.toMatch(/superscript|committee amendments|recommendations/);
});

test('a technical-review file is labelled as such', () => {
  const t1 = new URL('/Bills/2026/A3000/3000_T1.PDF', 'https://pub.njleg.gov')
    .href;
  expect(
    newJerseyMetadata(bill.replace('[First Reprint]\n', ''), {
      sourceUrl: t1,
    }).version,
  ).toBe('Technical Review');
});

const njIds = (...lines: string[]) =>
  [
    ...walkSections(parseText([cover, ...lines].join('\n'), context).sections),
  ].map((s) => s.id);

test('NJ: a bill section that shares a quoted section number is still a bill section', () => {
  // The appropriation is bill section 2 even though the quote above it was statute section 2.
  expect(
    njIds(
      '1. Section 2 of P.L.1985, c.222 (C.52:27D-302) is amended to read as follows:',
      '2. The Legislature finds that housing is needed.',
      '(cf: P.L.1985, c.222, s.2)',
      '2. There is appropriated $1,000 to the department.',
      '3. This act shall take effect immediately.',
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/2', 'sec-2', 'sec-3']);
});

test('NJ: numbers inside a quote are not bill sections until its "(cf: ...)" ends it', () => {
  expect(
    njIds(
      '1. Section 3 of P.L.1976, c.45 (C.40A:14-156.3) is amended to read as follows:',
      '3. If a member is injured while on duty',
      'the municipality shall pay.',
      '2. A subdivision of the quoted law.',
      '(cf: P.L.1976, c.45, s.3)',
      '2. This act shall take effect immediately.',
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/3', 'sec-1/2', 'sec-2']);
});

test('NJ: new text that says "as follows" is not a quote', () => {
  expect(
    njIds(
      '1. (New section) The task force shall be composed as follows:',
      'a. the Secretary of Agriculture.',
      '2. This act shall take effect immediately.',
    ),
  ).toEqual(['preamble', 'sec-1', 'sec-1/a', 'sec-2']);
});

test('NJ: a lone (a) followed by b. does not pull b. under paragraph (1)', () => {
  expect(
    njIds(
      '1. R.S.1:1-1 is amended to read as follows:',
      'a. The commission shall:',
      '(1) issue a certificate to a person who:',
      '(a) is at least 18 years of age.',
      'b. The commission shall report.',
    ),
  ).toEqual([
    'preamble',
    'sec-1',
    'sec-1/a',
    'sec-1/a/1',
    'sec-1/a/1/a',
    'sec-1/b',
  ]);
});

test('NJ: a quoted statute section is labelled "§ N", never like a paragraph', () => {
  const doc = parseText(
    [
      cover,
      ...[
        '1. Section 2 of P.L.1985, c.222 (C.52:27D-302) is amended to read as follows:',
        '2. The Legislature finds that housing is needed.',
        '(cf: P.L.1985, c.222, s.2)',
        '2. This act shall take effect immediately.',
      ],
    ].join('\n'),
    context,
  );
  const quoted = [...walkSections(doc.sections)].find(
    (s) => s.id === 'sec-1/2',
  );
  expect(quoted?.num).toBe('§ 2');
});
