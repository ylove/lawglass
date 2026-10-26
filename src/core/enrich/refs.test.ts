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

  it.each([
    ['such Act', 'section 3 of such Act'],
    ['that Act', 'section 3 of that Act'],
    ['Public Law', 'section 3 of Public Law 117-58'],
    ['Ohio bill', 'section 3 of H.B. 110 of the 134th General Assembly'],
    ['USC range', 'sections 1 through 3 of title 18, United States Code'],
    ['title, comma form', 'title 18, United States Code, section 3'],
    ['such title', 'section 3 of such title'],
    ['chapter', 'section 3 of chapter 5'],
    ['subdivision of such Act', 'subsection (A) of section 3 of such Act'],
  ])('does not resolve %s to a section of this document', (_name, text) => {
    expect(findInternalRefs(`See ${text}.`, 'sec-9', index)).toEqual([]);
  });

  it.each([
    ['section 3, relating to fees', ['sec-3']],
    ['section 3 of this chapter', ['sec-3']],
    ['section 3 in this act', ['sec-3']],
  ])('still resolves %j', (text, expected) => {
    expect(findInternalRefs(`See ${text}.`, 'sec-9', index)).toEqual(expected);
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

describe('findExternalMatches ranges', () => {
  it('reports a range of United States Code sections', () => {
    expect(
      findExternalMatches(
        'sections 1 through 3 of title 18, United States Code',
      ).map((m) => m.citation),
    ).toEqual(['18 U.S.C. 1 to 3']);
    expect(
      findExternalMatches(
        'sections 1 and 3 of title 18, United States Code',
      ).map((m) => m.citation),
    ).toEqual(['18 U.S.C. 1', '18 U.S.C. 3']);
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
    ['26 CFR 1.1-1', '26 CFR 1.1-1', 'cfr'],
    ['title 5, United States Code, section 552', '5 U.S.C. 552', 'us_code'],
    [
      'section 2 of H.B. 110 of the 134th General Assembly',
      'H.B. 110 (134th General Assembly) § 2',
      'other',
    ],
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

it('New York law citations are external state_code refs, even when bill section numbers coincide', () => {
  const hits = findExternalMatches(
    'section 1-a of the public health law and section 2 of the education law',
    { jurisdiction: 'New York' },
  );
  expect(hits.map((h) => [h.kind, h.citation])).toEqual([
    ['state_code', 'New York public health law § 1-a'],
    ['state_code', 'New York education law § 2'],
  ]);
  expect(findExternalMatches('section 1-a of the public health law')).toEqual(
    [],
  );
});

describe('U.S. Code sections written with a typographic dash', () => {
  const cites = (text: string) =>
    findExternalMatches(text).map((m) => m.citation);
  it('keeps a lettered section whole ("1395w–4") and takes the first of a numeric range', () => {
    expect(cites('under 42 U.S.C. 1395w–4 and 42 U.S.C. 1395w—4')).toEqual([
      '42 U.S.C. 1395w-4',
      '42 U.S.C. 1395w-4',
    ]);
    expect(cites('see 42 U.S.C. 1395–1396')).toEqual(['42 U.S.C. 1395']);
    expect(cites('see 42 U.S.C. 1395w-4')).toEqual(['42 U.S.C. 1395w-4']);
  });
});

it('New Jersey statute citations are external state_code refs only for NJ bills', () => {
  const text =
    'R.S.37:1-13 and N.J.S.A. 2C:12-1 and section 1 of P.L.2023, c.78 (C.55:14K-104 et al.)';
  const hits = findExternalMatches(text, { jurisdiction: 'New Jersey' });
  expect(hits.map((h) => [h.kind, h.citation])).toEqual([
    ['state_code', 'N.J. R.S. 37:1-13'],
    ['state_code', 'N.J.S.A. 2C:12-1'],
    ['state_code', 'N.J. P.L.2023, c.78'],
    ['state_code', 'N.J.S.A. 55:14K-104'],
  ]);
  expect(findExternalMatches(text)).toEqual([]);
});
