import { describe, expect, it } from 'vitest';
import { sec } from './fixtures.js';
import {
  ancestry,
  buildSectionIndex,
  enclosingSection,
  normalizeDesignator,
  normalizeSectionNum,
} from './section-index.js';

describe('section index helpers', () => {
  it.each([
    ['3', '3'],
    ['Sec. 3.', '3'],
    ['SECTION 5747.01', '5747.01'],
    ['§ 12', '12'],
    ['(b)', undefined],
    ['', undefined],
  ])('normalizes section number %j', (input, expected) => {
    expect(normalizeSectionNum(input)).toBe(expected);
  });

  it('normalizes designators but keeps case', () => {
    expect(normalizeDesignator('(A)')).toBe('A');
    expect(normalizeDesignator('(a).')).toBe('a');
  });

  const tree = [
    sec('s1', '', {
      num: '1',
      children: [
        sec('s1/a', '', {
          num: '(a)',
          level: 2,
          children: [sec('s1/a/1', '', { num: '(1)', level: 3 })],
        }),
      ],
    }),
    sec('s1dup', '', { num: '1' }),
    sec('bare', ''),
  ];
  const index = buildSectionIndex(tree);

  it('keeps the first section for a duplicate number', () => {
    expect(index.bySectionNum.get('1')).toBe('s1');
  });

  it('builds ancestry root-first, and empty for unknown ids', () => {
    expect(ancestry(index, 's1/a/1').map((s) => s.id)).toEqual([
      's1',
      's1/a',
      's1/a/1',
    ]);
    expect(ancestry(index, 'nope')).toEqual([]);
  });

  it('finds the numbered enclosing section, falling back to the root', () => {
    expect(enclosingSection(index, 's1/a/1')?.id).toBe('s1');
    expect(enclosingSection(index, 'bare')?.id).toBe('bare');
    expect(enclosingSection(index, 'nope')).toBeUndefined();
  });
});
