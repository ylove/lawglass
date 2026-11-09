import { describe, expect, test } from 'vitest';
import { resolveNewJersey } from '../fetch/new-jersey.js';
import { resolveNewYork } from '../fetch/new-york.js';
import { resolveHistory } from '../history/resolve.js';
import { billIngestUrl, findBillMentions } from './bill-refs.js';
import { findExternalMatches } from './refs.js';

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
      ['other', 'H.B. 110 (134th General Assembly) § 5'],
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
