import { describe, expect, it } from 'vitest';
import { sec } from './fixtures.js';
import {
  collectExternalRefs,
  findExternalMatches,
  findInternalRefs,
} from './refs.js';
import { buildSectionIndex } from './section-index.js';

const tree = [
  sec('sec-1', 'Short title.', { num: '1' }),
  sec('sec-3', '', {
    num: '3',
    children: [
      sec('sec-3/A', 'Text.', {
        num: '(A)',
        level: 2,
        children: [
          sec('sec-3/A/1', 'Text.', { num: '(1)', level: 3 }),
          sec('sec-3/A/2', 'Text.', { num: '(2)', level: 3 }),
        ],
      }),
      sec('sec-3/B', 'Text.', { num: '(B)', level: 2 }),
    ],
  }),
  sec('sec-5747.01', 'Tax.', { num: '5747.01' }),
  sec('sec-9', 'Other.', { num: 'Sec. 9.' }),
];
const index = buildSectionIndex(tree);

describe('findInternalRefs', () => {
  it.each([
    ['section 3 of this act', 'sec-1', ['sec-3']],
    ['Section 3 of this Act', 'sec-1', ['sec-3']],
    ['sections 3 and 9 of this act', 'sec-1', ['sec-3', 'sec-9']],
    ['sections 1, 3, and 9', 'sec-5747.01', ['sec-1', 'sec-3', 'sec-9']],
    ['section 3(A)(2)', 'sec-1', ['sec-3/A/2']],
    ['section 5747.01 of this act', 'sec-1', ['sec-5747.01']],
    ['subsection (B)', 'sec-3/A/1', ['sec-3/B']],
    ['paragraph (2) of this subsection', 'sec-3/A', ['sec-3/A/2']],
    ['division (A)(2) of this section', 'sec-3/B', ['sec-3/A/2']],
    ['division (A)(2) of section 3', 'sec-1', ['sec-3/A/2']],
    ['subsections (A) and (B)', 'sec-3/A/1', ['sec-3/A', 'sec-3/B']],
    ['division (A)(9)', 'sec-3/B', ['sec-3/A']],
  ])('resolves %j from %s', (text, from, expected) => {
    expect(findInternalRefs(`See ${text}.`, from, index)).toEqual(expected);
  });

  it.each([
    ['unknown section', 'section 77 of this act', 'sec-1'],
    ['unknown subdivision', 'subsection (Z)', 'sec-3/B'],
    ['self reference', 'section 1', 'sec-1'],
    ["someone else's code", 'section 3 of the Internal Revenue Code', 'sec-1'],
    ['Revised Code section', 'section 6000.01 of the Revised Code', 'sec-1'],
    ['no reference at all', 'The tax is due.', 'sec-1'],
    ['unknown origin section', 'subsection (A)', 'nope'],
  ])('ignores %s', (_name, text, from) => {
    expect(findInternalRefs(text, from, index)).toEqual([]);
  });

  it('links a Revised Code section that this document reprints', () => {
    expect(
      findInternalRefs(
        'under section 5747.01 of the Revised Code',
        'sec-1',
        index,
      ),
    ).toEqual(['sec-5747.01']);
  });

  it('does not treat a division of an external section as internal', () => {
    expect(
      findInternalRefs(
        'division (A)(2) of section 6000.01 of the Revised Code',
        'sec-3/B',
        index,
      ),
    ).toEqual([]);
  });
});

describe('findExternalMatches', () => {
  it.each([
    ['section 5747.01 of the Revised Code', 'R.C. 5747.01', 'state_code'],
    [
      'division (A)(2) of section 5747.01 of the Ohio Revised Code',
      'R.C. 5747.01',
      'state_code',
    ],
    [
      'sections 5747.01 to 5747.15 of the Revised Code',
      'R.C. 5747.01 to 5747.15',
      'state_code',
    ],
    ['Chapter 5747. of the Revised Code', 'R.C. Chapter 5747', 'state_code'],
    ['42 U.S.C. 1983', '42 U.S.C. 1983', 'us_code'],
    ['42 U.S.C. § 1983(a)', '42 U.S.C. 1983', 'us_code'],
    ['42 USC 1983', '42 U.S.C. 1983', 'us_code'],
    ['section 101 of title 5, United States Code', '5 U.S.C. 101', 'us_code'],
    [
      'section 6 of the Internal Revenue Code of 1986',
      '26 U.S.C. 6',
      'us_code',
    ],
    ['Public Law 118-31', 'Public Law 118-31', 'public_law'],
    ['Pub. L. 118–31', 'Public Law 118-31', 'public_law'],
    ['Public Law No. 117-2', 'Public Law 117-2', 'public_law'],
    ['40 CFR 60', '40 CFR 60', 'cfr'],
    ['40 C.F.R. part 60.1', '40 CFR 60.1', 'cfr'],
    [
      'section 1902 of the Social Security Act',
      'Social Security Act § 1902',
      'other',
    ],
  ])('recognizes %j', (text, citation, kind) => {
    const matches = findExternalMatches(`As provided in ${text}, ...`);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ citation, kind });
    expect(text.startsWith(matches[0]?.text ?? '?')).toBe(true);
  });

  it('reports each section of a list separately', () => {
    const matches = findExternalMatches(
      'sections 109.57, 109.572 and 2151.01 of the Revised Code',
    );
    expect(matches.map((m) => m.citation)).toEqual([
      'R.C. 109.57',
      'R.C. 109.572',
      'R.C. 2151.01',
    ]);
  });

  it('does not report internal-looking or non-citation text', () => {
    expect(findExternalMatches('section 3 of this act')).toEqual([]);
    expect(findExternalMatches('In 2020 there were 40 cases.')).toEqual([]);
    expect(findExternalMatches('')).toEqual([]);
  });
});

describe('collectExternalRefs', () => {
  const sections = [
    sec('sec-1', 'Per 42 U.S.C. 1983 and section 6000.01 of the Revised Code.'),
    sec('sec-2', 'Again 42 U.S.C. § 1983 and Public Law 118-31.'),
    sec('sec-3', '', {
      spans: [
        { text: 'Struck 40 CFR 60. ', status: 'deleted' },
        { text: 'Kept 40 CFR 61.', status: 'unchanged' },
      ],
    }),
    sec('sec-5747.01', 'Mentions section 5747.01 of the Revised Code.', {
      num: '5747.01',
    }),
  ];

  it('dedupes by citation and lists every citing section', () => {
    const refs = collectExternalRefs(sections, buildSectionIndex(sections));
    const usc = refs.find((r) => r.citation === '42 U.S.C. 1983');
    expect(usc).toMatchObject({
      kind: 'us_code',
      text: '42 U.S.C. 1983',
      sectionIds: ['sec-1', 'sec-2'],
    });
    expect(refs.filter((r) => r.citation === '42 U.S.C. 1983')).toHaveLength(1);
  });

  it('skips struck text and Revised Code sections the document contains', () => {
    const citations = collectExternalRefs(
      sections,
      buildSectionIndex(sections),
    ).map((r) => r.citation);
    expect(citations).toEqual([
      '42 U.S.C. 1983',
      'R.C. 6000.01',
      'Public Law 118-31',
      '40 CFR 61',
    ]);
  });

  it('merges refs the parser already supplied without mutating them', () => {
    const existing = [
      {
        text: 'x',
        citation: '42 U.S.C. 1983',
        kind: 'us_code' as const,
        sectionIds: ['sec-0'],
      },
    ];
    const refs = collectExternalRefs(
      sections,
      buildSectionIndex(sections),
      existing,
    );
    expect(refs[0]?.sectionIds).toEqual(['sec-0', 'sec-1', 'sec-2']);
    expect(existing[0]?.sectionIds).toEqual(['sec-0']);
  });
});
