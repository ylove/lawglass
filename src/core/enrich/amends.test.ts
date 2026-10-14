import { describe, expect, it } from 'vitest';
import { detectAmends } from './amends.js';
import { enrichDocument } from './index.js';
import { docOf, sec } from './fixtures.js';
import type { Section } from '../model/index.js';

const meta = (
  title: string | null = null,
  jurisdiction: string | null = 'Ohio',
) => ({
  title,
  jurisdiction,
});

const marked = (id: string, num: string, text: string): Section => ({
  ...sec(id, '', { num }),
  spans: [
    { text: 'Old ', status: 'deleted' },
    { text, status: 'inserted' },
  ],
});

describe('detectAmends', () => {
  it('reads "To amend the City Charter" and restated sections with markup', () => {
    const sections = [
      sec('sec-1', 'To amend the City Charter of Columbus.', {
        num: '1',
      }),
      marked('sec-3', 'Sec. 3.', 'New rule.'),
      marked('sec-46-3', 'Sec. 46-3.', 'Other rule.'),
    ];
    expect(detectAmends(sections, meta())).toEqual({
      name: 'City Charter',
      jurisdiction: 'Ohio',
      sections: ['3', '46-3'],
    });
  });

  it('names the city and keeps explicitly listed sections, listed ones first, deduped', () => {
    const sections = [
      sec(
        'sec-1',
        'to amend Sections 3 and 7 of the Charter of the City of Columbus.',
        { num: '1' },
      ),
      marked('sec-3', 'Sec. 3.', 'Changed.'),
    ];
    expect(detectAmends(sections, meta(null, null))).toEqual({
      name: 'Columbus City Charter',
      sections: ['3', '7'],
    });
  });

  it('accepts the amend verb after the mention, and the title as a source', () => {
    expect(
      detectAmends(
        [sec('s', 'Section 3 of the charter is hereby amended.')],
        meta(),
      )?.sections,
    ).toEqual(['3']);
    expect(
      detectAmends([sec('s', 'Body.')], meta('To amend the City Charter')),
    ).toMatchObject({ name: 'City Charter', sections: [] });
  });

  it('ignores a charter that is only mentioned, and bill-level markup', () => {
    expect(
      detectAmends(
        [sec('s', 'Acting under the City Charter, council meets.')],
        meta(),
      ),
    ).toBeUndefined();
    expect(
      detectAmends([sec('s', 'To amend the Revised Code.')], meta()),
    ).toBeUndefined();
  });

  it('finds an amendment clause nested in a child section', () => {
    const outer = sec('sec-1', '', {
      num: '1',
      children: [
        sec('sec-1/a', 'To amend the Charter of the City of Columbus.', {
          num: '(a)',
          level: 2,
        }),
      ],
    });
    expect(detectAmends([outer], meta())?.name).toBe('Columbus City Charter');
  });

  it('does not let an amend verb in another sentence reach the charter', () => {
    expect(
      detectAmends(
        [
          sec(
            's',
            'To amend the Columbus City Code. Procedures under the City Charter remain unchanged.',
          ),
        ],
        meta(),
      ),
    ).toBeUndefined();
  });

  it('does not count a bill section that merely contains the restated ones', () => {
    const outer = sec('sec-1', 'To amend the City Charter.', {
      num: '1',
      children: [marked('sec-1/a', 'Sec. 5.', 'x')],
    });
    expect(detectAmends([outer], meta())?.sections).toEqual(['5']);
  });
});

describe('enrichDocument amends', () => {
  const sections = [
    sec('sec-1', 'To amend Section 3 of the City Charter.', { num: '1' }),
    marked('sec-3', 'Sec. 3.', 'Restated text.'),
  ];

  it('fills metadata.amends and links the cited section inward', () => {
    const { doc } = enrichDocument(docOf(sections), []);
    expect(doc.metadata.amends).toEqual({
      name: 'City Charter',
      sections: ['3'],
    });
    expect(doc.externalRefs).toEqual([]);
  });

  it('keeps an amends value that was already set', () => {
    const input = docOf(sections);
    input.metadata.amends = { name: 'Given', sections: [] };
    expect(enrichDocument(input, []).doc.metadata.amends?.name).toBe('Given');
  });

  it('leaves metadata alone when nothing is amended', () => {
    const { doc } = enrichDocument(docOf([sec('s', 'Plain text.')]), []);
    expect(doc.metadata.amends).toBeUndefined();
  });

  it('maps general election laws using the document jurisdiction', () => {
    const input = docOf([
      sec('s', 'Follows the general election laws of the state.'),
    ]);
    input.metadata.jurisdiction = 'Ohio';
    expect(enrichDocument(input, []).doc.externalRefs[0]).toMatchObject({
      citation: 'Ohio Revised Code, Title 35',
      category: 'general_law',
    });
  });
});
