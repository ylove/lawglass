import { describe, expect, test } from 'vitest';
import { resolveNewJersey } from '../fetch/new-jersey.js';
import { resolveNewYork } from '../fetch/new-york.js';
import { resolveHistory } from '../history/resolve.js';
import { billIngestUrl, findBillMentions } from './bill-refs.js';
import { collectExternalRefs, findExternalMatches } from './refs.js';
import { buildSectionIndex } from './section-index.js';

const federal = {
  jurisdiction: 'United States',
  session: '118th Congress, 1st Session',
};
const ohio = { jurisdiction: 'Ohio', session: '135th General Assembly' };
const citations = (text: string, ctx = {}): string[] =>
  findBillMentions(text, ctx).map((m) => m.citation);

describe('federal bills', () => {
  test('a stated congress wins in any document', () => {
    expect(citations('as in H.R. 1234 of the 117th Congress.')).toEqual([
      'H.R. 1234 (117th Congress)',
    ]);
    expect(citations('see S.J.Res. 7 (116th Congress)')).toEqual([
      'S.J.Res. 7 (116th Congress)',
    ]);
    expect(citations('H. R. 22 (112th Congress)')).toEqual([]);
  });
  test('without a stated congress the document must be federal', () => {
    expect(citations('see H.R. 55 and S. 5 and H. Res. 9', federal)).toEqual([
      'H.R. 55 (118th Congress)',
      'S. 5 (118th Congress)',
      'H.Res. 9 (118th Congress)',
    ]);
    expect(citations('see H.R. 55 and S. 5')).toEqual([]);
    expect(citations('see H.R. 55', ohio)).toEqual([]);
    expect(citations('Senate Bill 12', federal)).toEqual([
      'S. 12 (118th Congress)',
    ]);
  });
  test('all resolution types are named', () => {
    expect(
      citations(
        'H.J.Res. 1, S.J.Res. 2, H.Con.Res. 3, S.Con.Res. 4, H.Res. 5, S.Res. 6',
        federal,
      ),
    ).toEqual([
      'H.J.Res. 1 (118th Congress)',
      'S.J.Res. 2 (118th Congress)',
      'H.Con.Res. 3 (118th Congress)',
      'S.Con.Res. 4 (118th Congress)',
      'H.Res. 5 (118th Congress)',
      'S.Res. 6 (118th Congress)',
    ]);
  });
  test.each([
    '42 U.S.C. 5',
    '410 U.S. 113 (1973)',
    'section 5 of this Act',
    'Sec. 5. Definitions',
    'under S. Rept. 105',
    'H. Rept. 118-5',
    'H.R. Rep. No. 105',
    'costs of $5.5 million',
    'S. 5.5',
    'Pub. L. 118-5',
    'S. 12345678',
  ])('does not link %s', (text) => {
    expect(citations(text, federal)).toEqual([]);
  });
});

describe('Ohio bills', () => {
  test('stated or current general assembly', () => {
    expect(citations('H.B. 33 of the 135th General Assembly')).toEqual([
      'H.B. 33 (135th General Assembly)',
    ]);
    expect(citations('House Bill 110 and S.B. 9', ohio)).toEqual([
      'H.B. 110 (135th General Assembly)',
      'S.B. 9 (135th General Assembly)',
    ]);
  });
  test('ambiguous without a session', () => {
    expect(citations('H.B. 33')).toEqual([]);
    expect(
      citations('H.B. 33', { jurisdiction: 'Ohio', session: null }),
    ).toEqual([]);
  });
});

describe('New York and New Jersey bills', () => {
  const ny = {
    jurisdiction: 'New York',
    session: '2025-2026 Regular Sessions',
  };
  const nj = { jurisdiction: 'New Jersey', session: '221st Legislature' };
  test('only inside a document of that state with a session', () => {
    expect(citations('Senate Bill S1234 and Assembly Bill 55', ny)).toEqual([
      'N.Y. S1234 (2025)',
      'N.Y. A55 (2025)',
    ]);
    expect(citations('see A1500', ny)).toEqual(['N.Y. A1500 (2025)']);
    expect(citations('Senate Bill S1234')).toEqual([]);
    expect(citations('Senate Bill 12 and Assembly Bill No. 7', nj)).toEqual([
      'N.J. S12 (2024)',
      'N.J. A7 (2024)',
    ]);
    expect(citations('Senate Bill 12', { jurisdiction: 'New York' })).toEqual(
      [],
    );
  });
  test('short or contradictory forms do not link', () => {
    expect(citations('S5 and A12 and Senate Bill A12', ny)).toEqual([]);
  });
});

describe('integration with external refs', () => {
  test('bills come out of findExternalMatches as kind other, and statutes stay statutes', () => {
    const matches = findExternalMatches(
      'Compare H.R. 9 of the 117th Congress with 42 U.S.C. 5 and section 5 of H.B. 110 of the 134th General Assembly.',
      {},
    );
    expect(matches.map((m) => [m.kind, m.citation])).toEqual([
      ['other', 'H.R. 9 (117th Congress)'],
      ['us_code', '42 U.S.C. 5'],
      ['other', 'H.B. 110 (134th General Assembly)'],
    ]);
  });
});

describe('billIngestUrl maps to addresses the resolvers accept', () => {
  test('federal', () => {
    const url = billIngestUrl('H.J.Res. 7 (117th Congress)');
    expect(url).toBe(
      'https://www.congress.gov/bill/117th-congress/house-joint-resolution/7',
    );
    expect(resolveHistory(url ?? '')).toMatchObject({
      source: 'govinfo',
      congress: 117,
      type: 'hjres',
      number: 7,
    });
    expect(billIngestUrl('S. 2 (112th Congress)')).toContain('112th-congress');
    expect(billIngestUrl('S. 2 (111th Congress)')).toBeDefined();
  });
  test('Ohio', () => {
    const url = billIngestUrl('S.B. 9 (135th General Assembly)');
    expect(url).toBe('https://www.legislature.ohio.gov/legislation/135/sb9');
    expect(resolveHistory(url ?? '')).toMatchObject({
      source: 'ohio',
      ga: '135',
      bill: 'sb9',
    });
  });
  test('New York', () => {
    const url = billIngestUrl('N.Y. S1234 (2025)');
    expect(url).toBe('https://www.nysenate.gov/legislation/bills/2025/S1234');
    expect(resolveNewYork(url ?? '')).toMatchObject({ latest: true });
    expect(
      resolveNewYork(billIngestUrl('N.Y. A55 (2025)') ?? ''),
    ).toBeDefined();
  });
  test('New Jersey', () => {
    const url = billIngestUrl('N.J. S12 (2024)');
    expect(url).toBe('https://www.njleg.state.nj.us/bill-search/2024/S12');
    expect(resolveNewJersey(url ?? '')?.lookup).toEqual({
      session: 2024,
      bill: 'S12',
    });
  });
  test('anything else is not a bill', () => {
    for (const c of ['42 U.S.C. 5', 'R.C. 5747.01', 'H.R. 5', 'N.Y. S1 (1800)'])
      expect(billIngestUrl(c)).toBeUndefined();
  });
});

describe('explicit qualifiers win over the current session', () => {
  test('a parenthesized or "of the" session is read, never overridden', () => {
    expect(citations('H.B. 110 (134th General Assembly)', ohio)).toEqual([
      'H.B. 110 (134th General Assembly)',
    ]);
    expect(citations('S.B. 9 of the 133rd General Assembly', ohio)).toEqual([
      'S.B. 9 (133rd General Assembly)',
    ]);
  });
  test.each([
    ['H.B. 110 (134th Legislature)', ohio],
    ['H.B. 110 (2021-2022 session)', ohio],
    ['H.B. 110 of the 134th Congress', ohio],
    ['H.R. 5 (134th General Assembly)', federal],
    ['H.R. 5 of the 2019 session', federal],
    ['H.R. 5 in the 117th', federal],
  ])('unsupported qualifier stays plain text: %s', (text, ctx) => {
    expect(citations(text, ctx)).toEqual([]);
  });
});

describe('spaced reporter citations are not bills', () => {
  test.each([
    'Brown v. Board of Education, 347 U. S. 483 (1954)',
    'Marbury v. Madison, 5 U. S. 137 (1803)',
    'Roe v. Wade, 410 U.S. 113 (1973)',
    'Smith v. Jones, 98 S. Ct. 2733 (1978)',
    'Doe v. Roe, 109 F. Supp. 2d 1 (D. Mass. 2000)',
    'Rex v. Lee, 54 L. Ed. 2d 5 (1977)',
    'see 347 S. 483',
  ])('%s', (text) => {
    expect(citations(text, federal)).toEqual([]);
  });
});

describe('section-qualified Ohio bills keep an identity', () => {
  test('one citation shape with plain mentions', () => {
    const matches = findExternalMatches(
      'section 5 of H.B. 110 of the 134th General Assembly, and H.B. 110 (134th General Assembly), and section 6 of Am. Sub. S.B. 9 (133rd General Assembly)',
      ohio,
    );
    expect(matches.map((m) => m.citation)).toEqual([
      'H.B. 110 (134th General Assembly)',
      'H.B. 110 (134th General Assembly)',
      'S.B. 9 (133rd General Assembly)',
    ]);
    expect(billIngestUrl(matches[0]?.citation ?? '')).toBe(
      'https://www.legislature.ohio.gov/legislation/134/hb110',
    );
  });
  test('without a stated assembly there is only plain text', () => {
    expect(
      findExternalMatches('section 5 of H.B. 110', ohio).map((m) => m.citation),
    ).toEqual(['H.B. 110 § 5']);
  });
});

describe('self references', () => {
  const refsFor = (text: string, ctx: object) =>
    collectExternalRefs(
      [
        {
          id: 's1',
          heading: null,
          number: '1',
          kind: 'section',
          spans: [{ text, status: 'normal' }],
          children: [],
        } as never,
      ],
      buildSectionIndex([]),
      [],
      ctx,
    ).map((r) => r.citation);
  test('a bill naming its own number is not a reference to itself', () => {
    const ctx = { ...federal, billNumber: 'H. R. 1234' };
    expect(refsFor('See H.R. 1234 and H.R. 99.', ctx)).toEqual([
      'H.R. 99 (118th Congress)',
    ]);
    const nj = {
      ...{ jurisdiction: 'New Jersey', session: '221st Legislature' },
      billNumber: 'S. 1000',
    };
    expect(refsFor('S. 1000 and S. 1001', nj)).toEqual(['N.J. S1001 (2024)']);
  });
  test('a different session or type is another bill', () => {
    const ctx = { ...federal, billNumber: 'H.R. 1234' };
    expect(
      refsFor('H.R. 1234 of the 117th Congress. See also S. 1234.', ctx),
    ).toEqual(['H.R. 1234 (117th Congress)', 'S. 1234 (118th Congress)']);
  });
});

describe('New York and New Jersey short forms', () => {
  const nj = { jurisdiction: 'New Jersey', session: '221st Legislature' };
  const ny = {
    jurisdiction: 'New York',
    session: '2025-2026 Regular Sessions',
  };
  test('dotted, dashed and attached forms', () => {
    expect(citations('S. 1000 and A. 3000', nj)).toEqual([
      'N.J. S1000 (2024)',
      'N.J. A3000 (2024)',
    ]);
    expect(citations('S1000, A-3000 and Senate Bill No. 1000', ny)).toEqual([
      'N.Y. S1000 (2025)',
      'N.Y. A3000 (2025)',
      'N.Y. S1000 (2025)',
    ]);
  });
  test.each([
    'A. Definitions',
    'A. 12',
    'section A-12',
    'N.J.S.A. 2C:12-1',
    'N.J.S.A. 120:12-1',
    'R.S.37:1-13',
    'Exhibit CA-3000',
    '347 U. S. 483',
    'P.L.2023, c.100',
    'Senate Bill 1000 (2021-2022 session)',
    'A-3000:4',
  ])('does not link %s', (text) => {
    expect(citations(text, nj)).toEqual([]);
  });
  test('only with a known session in a document of that state', () => {
    expect(citations('S. 1000')).toEqual([]);
    expect(citations('S. 1000', { jurisdiction: 'New Jersey' })).toEqual([]);
  });
});

describe('real Ohio boilerplate (SB 113, 136th General Assembly)', () => {
  const sb113 = {
    jurisdiction: 'Ohio',
    session: '136th General Assembly, Regular Session 2025-2026',
    billNumber: 'S.B. No. 113',
  };
  const text =
    'Section 3314.03 of the Revised Code as amended by H.B. 214, H.B. 250, and S.B. 168, all of the 135th General Assembly. Section 3326.11 of the Revised Code as amended by H.B. 47, H.B. 214, and S.B. 168, all of the 135th General Assembly. Section 3328.24 of the Revised Code as amended by H.B. 47 and H.B. 214 of the 135th General Assembly.';
  test("every bill takes the list-level or stated assembly, never the document's own", () => {
    const got = citations(text, sb113);
    expect(got).toEqual([
      'H.B. 214 (135th General Assembly)',
      'H.B. 250 (135th General Assembly)',
      'S.B. 168 (135th General Assembly)',
      'H.B. 47 (135th General Assembly)',
      'H.B. 214 (135th General Assembly)',
      'S.B. 168 (135th General Assembly)',
      // "H.B. 47 and H.B. 214 of the 135th..." could qualify only the last bill, so H.B. 47
      // stays plain; H.B. 214 states its own assembly.
      'H.B. 214 (135th General Assembly)',
    ]);
    expect(got.join()).not.toContain('136th');
  });
  test('a list whose qualifier cannot be read stays plain', () => {
    expect(
      citations(
        'as amended by H.B. 214, H.B. 250, and S.B. 168, all of the 135th session.',
        sb113,
      ),
    ).toEqual([]);
    expect(
      citations(
        'as amended by H.R. 5 and S. 6, all of the 135th General Assembly',
        {
          jurisdiction: 'United States',
          session: '118th Congress, 1st Session',
        },
      ),
    ).toEqual([]);
  });
  test("a mention with no session phrase in its sentence inherits the document's", () => {
    expect(citations('This act supersedes H.B. 47.', sb113)).toEqual([
      'H.B. 47 (136th General Assembly)',
    ]);
    expect(
      citations(
        'The act was enacted in the 135th General Assembly. See H.B. 47.',
        sb113,
      ),
    ).toEqual(['H.B. 47 (136th General Assembly)']);
    expect(citations('H.B. 47, enacted that session.', sb113)).toEqual([]);
  });
  test('Am. Sub., Sub., Am. and Cf. prefixes still link', () => {
    expect(
      citations(
        'Section 265.10 of Am. Sub. H.B. 110 of the 134th General Assembly, as amended by Am. Sub. H.B. 33 of the 135th General Assembly',
        sb113,
      ),
    ).toEqual([
      'H.B. 110 (134th General Assembly)',
      'H.B. 33 (135th General Assembly)',
    ]);
    expect(
      citations('Sub. H.B. 166 of the 133rd General Assembly', sb113),
    ).toEqual(['H.B. 166 (133rd General Assembly)']);
    expect(
      citations('Am. S.B. 9 of the 130th General Assembly', sb113),
    ).toEqual(['S.B. 9 (130th General Assembly)']);
    expect(citations('Cf. H.R. 5 of the 118th Congress', sb113)).toEqual([
      'H.R. 5 (118th Congress)',
    ]);
  });
  test("the bill's own number, written with its prefixes, is a self reference", () => {
    const refs = collectExternalRefs(
      [
        {
          id: 's1',
          heading: null,
          number: '1',
          kind: 'section',
          spans: [
            {
              text: 'This amends Am. Sub. S.B. 113 and H.B. 47.',
              status: 'normal',
            },
          ],
          children: [],
        } as never,
      ],
      buildSectionIndex([]),
      [],
      { ...sb113, billNumber: 'Am. Sub. S.B. No. 113' },
    ).map((r) => r.citation);
    expect(refs).toEqual(['H.B. 47 (136th General Assembly)']);
  });
});

describe('qualifier wordings', () => {
  test.each([
    ['H.R. 3746, 118th Congress', 'H.R. 3746 (118th Congress)'],
    ['H.R. 3746 (118th Cong.)', 'H.R. 3746 (118th Congress)'],
    [
      'H.R. 3746 of the One Hundred Eighteenth Congress',
      'H.R. 3746 (118th Congress)',
    ],
    [
      'H.R. 3746 of the One Hundred Thirteenth Congress',
      'H.R. 3746 (113th Congress)',
    ],
    ['H.R. 3746 of the One Hundred Twenty-Nine Congress', undefined],
    ['H.B. 33 (134th G.A.)', 'H.B. 33 (134th General Assembly)'],
    [
      'S.B. 9, as enacted by the 133rd General Assembly',
      'S.B. 9 (133rd General Assembly)',
    ],
    [
      'H.R. 2617 (117th Congress) (Consolidated Appropriations Act, 2023)',
      'H.R. 2617 (117th Congress)',
    ],
    [
      'accompanying S.2226 of the 118th Congress (Senate Report 118–58)',
      'S. 2226 (118th Congress)',
    ],
  ])('%s', (text, expected) => {
    expect(
      citations(text, {
        jurisdiction: 'Ohio',
        session: '136th General Assembly',
      }),
    ).toEqual(expected ? [expected] : []);
  });
  test('a federal document with a different stated congress keeps the stated one', () => {
    expect(citations('S. 1000 of the 118th Congress (2021)', federal)).toEqual([
      'S. 1000 (118th Congress)',
    ]);
  });
});

describe('labels are not NY/NJ bills', () => {
  const nj = { jurisdiction: 'New Jersey', session: '221st Legislature' };
  const ny = {
    jurisdiction: 'New York',
    session: '2025-2026 Regular Sessions',
  };
  test.each([
    'See Exhibit A-100.',
    'Schedule A-1000 applies.',
    'on Form A-1040',
    'Route S-100',
    'room S-110',
    'Part A-1000',
    'subpart A-100 of part 200',
    'section 9 of part S-100',
  ])('%s', (text) => {
    expect(citations(text, nj)).toEqual([]);
    expect(citations(text, ny)).toEqual([]);
  });
  test('a bill cue keeps the real thing', () => {
    expect(citations('Introduced as S. 1000.', nj)).toEqual([
      'N.J. S1000 (2024)',
    ]);
  });
});

describe('honorifics and abbreviations do not cut a stated session off', () => {
  const fed119 = {
    jurisdiction: 'United States',
    session: '119th Congress, 1st Session',
  };
  const oh136 = {
    jurisdiction: 'Ohio',
    session: '136th General Assembly, Regular Session 2025-2026',
  };
  test.each([
    'H.R. 5, as introduced by Mr. Jordan in the 118th Congress, would have repealed the program.',
    'In the 118th Congress, Mr. Smith introduced H.R. 5.',
    'In the 118th Congress, Ms. Jones introduced H.R. 5.',
    'S. 5, introduced by Ms. Collins in the 118th Congress, was referred to committee.',
    'H.R. 5, introduced at the request of Gov. Smith during the 118th Congress, failed.',
    'H.R. 5, introduced at the request of Hon. Jane Doe during the 118th Congress, failed.',
    'H.R. 5 as reported by the Comm. On Ways and Means in the 118th Congress',
    'H.R. 5 (relating to the Dept. of Energy and Gen. Services Admin. Programs) of the 118th Congress',
  ])('federal: %s', (text) => {
    // Either the stated session or plain text; never the document's 119th.
    expect(citations(text, fed119).join()).not.toContain('119th');
  });
  test('Ohio: H.B. 33, sponsored by Mr. Edwards in the 135th General Assembly', () => {
    expect(
      citations(
        'H.B. 33, sponsored by Mr. Edwards in the 135th General Assembly, is amended.',
        oh136,
      ).join(),
    ).not.toContain('136th');
  });
});

describe('a bare repeat of a bill the text states elsewhere', () => {
  const fed119 = {
    jurisdiction: 'United States',
    session: '119th Congress, 1st Session',
  };
  const oh136 = { jurisdiction: 'Ohio', session: '136th General Assembly' };
  test('takes the stated session', () => {
    expect(
      citations(
        'The term "covered bill" means H.R. 5 of the 118th Congress. Not later than 90 days after the enactment of H.R. 5, the Secretary shall report.',
        fed119,
      ),
    ).toEqual(['H.R. 5 (118th Congress)', 'H.R. 5 (118th Congress)']);
    expect(
      citations(
        'Section 3 of H.B. 33 of the 135th General Assembly is amended. The amendment to H.B. 33 applies to fiscal year 2026.',
        oh136,
      ),
    ).toEqual([
      'H.B. 33 (135th General Assembly)',
      'H.B. 33 (135th General Assembly)',
    ]);
  });
  test('stays plain when the text states two sessions for it', () => {
    expect(
      citations(
        'H.B. 33 of the 134th General Assembly and H.B. 33 of the 135th General Assembly are amended. See H.B. 33.',
        oh136,
      ),
    ).toEqual([
      'H.B. 33 (134th General Assembly)',
      'H.B. 33 (135th General Assembly)',
    ]);
  });
  test('another bill number still inherits', () => {
    expect(
      citations('H.R. 5 of the 118th Congress. See H.R. 6.', fed119),
    ).toEqual(['H.R. 5 (118th Congress)', 'H.R. 6 (119th Congress)']);
  });
});

describe('undotted GA and Public Law numbers', () => {
  const oh136 = { jurisdiction: 'Ohio', session: '136th General Assembly' };
  const fed119 = {
    jurisdiction: 'United States',
    session: '119th Congress, 1st Session',
  };
  test('(130th GA) is a session qualifier', () => {
    expect(citations('Senate Bill 9 (130th GA) is repealed.', oh136)).toEqual([
      'S.B. 9 (130th General Assembly)',
    ]);
  });
  test('a Public Law in the sentence blocks inheriting', () => {
    expect(
      citations(
        'The Infrastructure Investment and Jobs Act (Public Law 117-58; H.R. 3684) is amended.',
        fed119,
      ),
    ).toEqual([]);
    expect(
      citations(
        'Section 3 of the Act (Pub. L. 117-58) enacted H.R. 3684.',
        fed119,
      ),
    ).toEqual([]);
    expect(
      citations('Public Law 117-58 (H.R. 3684 of the 117th Congress)', fed119),
    ).toEqual(['H.R. 3684 (117th Congress)']);
  });
});
