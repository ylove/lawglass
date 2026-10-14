import { describe, expect, it } from 'vitest';
import { sec } from './fixtures.js';
import {
  collectExternalRefs,
  findExternalMatches,
  findInternalRefs,
} from './refs.js';
import { buildSectionIndex } from './section-index.js';

const OHIO = { jurisdiction: 'Ohio' };
const only = (text: string, options = {}) => findExternalMatches(text, options);

describe('charter references', () => {
  it.each([
    ['amend the City Charter', 'City Charter', undefined],
    ['the Columbus City Charter', 'Columbus City Charter', 'Columbus'],
    [
      'the Charter of the City of Columbus',
      'Columbus City Charter',
      'Columbus',
    ],
    ['under the Charter', 'City Charter', undefined],
  ])('finds %s', (text, citation, city) => {
    const [m, ...rest] = only(text);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({ citation, kind: 'other', category: 'charter' });
    expect(m?.city).toBe(city);
  });

  it('reads a section list as one reference per section, with the number for linking', () => {
    const found = only(
      'Sections 3 and 46-3 of the Charter of the City of Toledo',
    );
    expect(found.map((m) => [m.citation, m.sectionNum])).toEqual([
      ['Toledo City Charter § 3', '3'],
      ['Toledo City Charter § 46-3', '46-3'],
    ]);
    expect(found.every((m) => m.category === 'charter')).toBe(true);
  });

  it('does not treat a lowercase "charter" word or a charter school as the charter', () => {
    expect(only('a charter school and a chartered bank')).toEqual([]);
    expect(only('Section 3 of the charter school act')).toEqual([]);
  });
});

describe('local code references', () => {
  it.each([
    ['Columbus City Code Section 1234.56', 'Columbus City Code § 1234.56'],
    ['City Code Section 12.3', 'City Code § 12.3'],
    ['The City Code Section 7', 'City Code § 7'],
    [
      'Section 1234.56 of the Columbus City Code',
      'Columbus City Code § 1234.56',
    ],
    ['Toledo Municipal Code sec. 9', 'Toledo City Code § 9'],
  ])('finds %s', (text, citation) => {
    const [m] = only(text);
    expect(m).toMatchObject({
      citation,
      kind: 'other',
      category: 'local_code',
    });
  });

  it('ignores a building code and the Revised Code', () => {
    expect(only('the building code, section 5')).toEqual([]);
    expect(only('Revised Code Section 5')).toEqual([]);
  });
});

describe('bare R.C. citations', () => {
  it('maps "R.C. 3501.01" to a state_code ref and keeps the section for linking', () => {
    const [m] = only('as defined in R.C. 3501.01(A)');
    expect(m).toMatchObject({
      citation: 'R.C. 3501.01',
      kind: 'state_code',
      sectionNum: '3501.01',
    });
    expect(only('RC 3501 and R.C. alone')).toEqual([]);
  });
});

describe('the general election laws of the state', () => {
  const text = 'in accordance with the general election laws of the state';
  it('maps to Ohio Revised Code Title 35 only when the jurisdiction is Ohio', () => {
    expect(only(text, OHIO)[0]).toMatchObject({
      citation: 'Ohio Revised Code, Title 35',
      kind: 'other',
      category: 'general_law',
    });
    for (const jurisdiction of ['Texas', null, undefined, 'United States'])
      expect(only(text, { jurisdiction })[0]?.citation).toBe(
        'State general election laws',
      );
    expect(only(text)[0]?.citation).toBe('State general election laws');
  });

  it('does not match unrelated election wording', () => {
    expect(only('the election laws of the county', OHIO)).toEqual([]);
  });
});

describe('collectExternalRefs with charter text', () => {
  it('lists refs as not loaded with their category, and never as a fetch target', () => {
    const tree = [
      sec('sec-1', 'Amend the Columbus City Charter and the City Charter.', {
        num: '1',
      }),
      sec(
        'sec-2',
        'See Columbus City Code Section 5.1 and the general election laws of the state.',
        { num: '2' },
      ),
    ];
    const refs = collectExternalRefs(tree, buildSectionIndex(tree), [], OHIO);
    expect(refs.map((r) => [r.citation, r.category])).toEqual([
      ['Columbus City Charter', 'charter'],
      ['Columbus City Code § 5.1', 'local_code'],
      ['Ohio Revised Code, Title 35', 'general_law'],
    ]);
    expect(refs[0]?.sectionIds).toEqual(['sec-1']);
  });
});

describe('internal links to restated charter sections', () => {
  const tree = [
    sec('sec-1', 'To amend Section 3 of the City Charter.', { num: '1' }),
    sec('sec-3', 'Council meets monthly.', { num: 'Sec. 3.' }),
  ];
  const index = buildSectionIndex(tree);

  it('links "Section 3 of the charter" inward when the document restates it', () => {
    expect(
      findInternalRefs('Section 3 of the charter is amended', 'sec-1', index),
    ).toEqual(['sec-3']);
    expect(collectExternalRefs(tree, index)).toEqual([]);
  });

  it('keeps it external when the section is not restated', () => {
    const lone = [
      sec('sec-1', 'Amend Section 9 of the City Charter.', { num: '1' }),
    ];
    const idx = buildSectionIndex(lone);
    expect(
      findInternalRefs('Section 9 of the City Charter', 'sec-1', idx),
    ).toEqual([]);
    expect(collectExternalRefs(lone, idx).map((r) => r.citation)).toEqual([
      'City Charter § 9',
    ]);
  });
});
