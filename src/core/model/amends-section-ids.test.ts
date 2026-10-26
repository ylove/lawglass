import { describe, expect, test } from 'vitest';
import { detectAmends } from '../enrich/amends.js';
import { AmendsTarget, type Section } from './index.js';

// Pins the additive `AmendsTarget.sectionIds` contract (#325): ids of the sections that
// reprint charter text, so a UI never links a charter number to the measure's own section.

function section(partial: Partial<Section> & Pick<Section, 'id'>): Section {
  return {
    level: 1,
    spans: [{ text: 'text', status: 'unchanged' }],
    children: [],
    ...partial,
  };
}

describe('AmendsTarget.sectionIds', () => {
  test('is optional, so older cached documents still parse', () => {
    expect(
      AmendsTarget.safeParse({ name: 'Charter', sections: ['3'] }).success,
    ).toBe(true);
    expect(
      AmendsTarget.safeParse({
        name: 'Charter',
        sections: ['3'],
        sectionIds: ['sec-3'],
      }).success,
    ).toBe(true);
  });

  test('detectAmends fills it from the sections that show marks', () => {
    const sections = [
      section({
        id: 'own-3',
        num: 'Section 3',
        spans: [
          {
            text: 'To amend Section 3 of the City Charter of Columbus.',
            status: 'unchanged',
          },
        ],
      }),
      section({
        id: 'sec-4',
        num: '4',
        spans: [{ text: 'new words', status: 'inserted' }],
      }),
    ];
    const amends = detectAmends(sections, {
      title: null,
      jurisdiction: 'City of Columbus, Ohio',
    });
    expect(amends?.sections).toContain('3');
    expect(amends?.sectionIds).toEqual(['sec-4']);
  });
});
