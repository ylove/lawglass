import { describe, expect, test } from 'vitest';
import type { OutlineItem } from '../../core/model/index.js';
import { filterBriefs, groupBriefs } from './breakdown-groups.js';
import { syntheticBill } from './synthetic-bill.js';

describe('groupBriefs', () => {
  test('groups 120 sections by their title, keeping document order', () => {
    const { outline, briefs } = syntheticBill();
    const groups = groupBriefs(briefs, outline);
    expect(groups?.map((g) => g.label)).toEqual([
      '1 Title 1 Farms',
      '2 Title 2 Schools',
      '3 Title 3 Roads',
    ]);
    expect(groups?.map((g) => g.briefs.length)).toEqual([40, 40, 40]);
    expect(groups?.[1]?.briefs[0]?.sectionId).toBe('sec-41');
  });

  test('groups only the briefs finished so far, and drops a group with none', () => {
    const { outline, briefs } = syntheticBill();
    const groups = groupBriefs(briefs.slice(0, 45), outline);
    expect(groups?.map((g) => g.briefs.length)).toEqual([40, 5]);
  });

  test('uses the top-level container when sections sit under nested subtitles', () => {
    const { briefs } = syntheticBill();
    const outline: OutlineItem[] = [
      { id: 'div-a', heading: 'Division A', level: 1 },
      { id: 'sub-1', heading: 'Subtitle 1', level: 2 },
      ...briefs.slice(0, 2).map((b) => ({ id: b.sectionId, level: 3 })),
      { id: 'div-b', heading: 'Division B', level: 1 },
      ...briefs.slice(2, 4).map((b) => ({ id: b.sectionId, level: 2 })),
    ];
    expect(
      groupBriefs(briefs.slice(0, 4), outline)?.map((g) => [
        g.label,
        g.briefs.length,
      ]),
    ).toEqual([
      ['Division A', 2],
      ['Division B', 2],
    ]);
  });

  test('parts the outline does not place go last, under "Other parts"', () => {
    const { outline, briefs } = syntheticBill();
    const stray = { ...briefs[0]!, sectionId: 'sec-unknown' };
    const groups = groupBriefs([...briefs.slice(0, 1), stray], outline);
    expect(groups?.map((g) => g.label)).toEqual([
      '1 Title 1 Farms',
      'Other parts',
    ]);
  });

  test('a flat bill, or one title, is not grouped', () => {
    const { briefs } = syntheticBill();
    const flat = briefs.map((b) => ({ id: b.sectionId, level: 1 }));
    expect(groupBriefs(briefs, flat)).toBeUndefined();
    expect(groupBriefs(briefs, undefined)).toBeUndefined();
    const oneTitle = [
      { id: 't', level: 1 },
      ...briefs.slice(0, 40).map((b) => ({ id: b.sectionId, level: 2 })),
    ];
    expect(groupBriefs(briefs.slice(0, 40), oneTitle)).toBeUndefined();
  });
});

describe('filterBriefs', () => {
  const { briefs } = syntheticBill();
  test('matches words in the heading, number or text, in any order and case', () => {
    expect(filterBriefs(briefs, '')).toBe(briefs);
    expect(filterBriefs(briefs, 'BUS garage').map((b) => b.sectionId)).toEqual([
      'sec-47',
    ]);
    expect(filterBriefs(briefs, 'garage bus')).toHaveLength(1);
    expect(filterBriefs(briefs, 'rule 119').map((b) => b.sectionId)).toEqual([
      'sec-119',
    ]);
  });
  test('does not match the citation markers', () => {
    expect(filterBriefs(briefs, 'sec-47')).toEqual([]);
    expect(filterBriefs(briefs, 'nothing like this')).toEqual([]);
  });
});
