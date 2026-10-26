import { describe, expect, it } from 'vitest';
import type { PicturePanel } from '../model/index.js';
import type { PictureItem } from './prompt.js';
import { validatePictures } from './validate.js';

const ITEMS: PictureItem[] = [
  {
    index: 0,
    text: 'Who can issue: bank subsidiaries, federally approved issuers, and state-approved issuers [S:sec-4].',
  },
  {
    index: 1,
    text: 'Reserves: issuers must hold at least 1 to 1 backing [S:sec-4/a]. They must publish reserve details monthly [S:sec-4/c].',
  },
  {
    index: 2,
    text: 'No interest paid to holders [S:sec-4/d].',
    sectionId: 'sec-4',
  },
];

const issue = (stamp?: string): PicturePanel => ({
  left: { glyphs: ['bank'] },
  link: 'to',
  carry: 'coins',
  right: { glyphs: ['person'] },
  ...(stamp ? { stamp: { glyph: 'seal' as const, label: stamp } } : {}),
});

describe('validatePictures', () => {
  it("keeps the brief's own examples: three issuer panels, reserves, no interest", () => {
    const { entries, dropped } = validatePictures(
      {
        pictures: [
          { item: 0, panels: [issue(), issue('Federal'), issue('State')] },
          {
            item: 1,
            panels: [
              {
                left: { glyphs: ['coins'], label: 'Reserves' },
                link: 'equals',
                right: {
                  glyphs: ['money', 'bank', 'document'],
                  label: '1 to 1',
                },
              },
              {
                left: { glyphs: ['calendar'] },
                link: 'to',
                carry: 'document',
                note: 'Monthly',
                right: { glyphs: ['people'] },
              },
            ],
          },
          {
            item: 2,
            panels: [
              {
                left: { glyphs: ['bank'] },
                link: 'blocked',
                carry: 'percent',
                right: { glyphs: ['person'], label: 'Holders' },
              },
            ],
          },
        ],
      },
      ITEMS,
    );
    expect(dropped).toEqual([]);
    expect(entries.map((e) => [e.item, e.panels.length])).toEqual([
      [0, 3],
      [1, 2],
      [2, 1],
    ]);
    // The entry carries the item's text exactly as written, markers and all.
    expect(entries[0]?.text).toBe(ITEMS[0]?.text);
    expect(entries[2]?.sectionId).toBe('sec-4');
    expect(entries[0]?.sectionId).toBeUndefined();
  });

  it('drops a picture whose label says something the item does not', () => {
    const cases: [PicturePanel, string][] = [
      [issue('Unsafe'), 'label-words'],
      [issue('Treasury'), 'label-words'],
      [issue('$500'), 'label-number'],
      [issue('2 to 1'), 'label-number'],
      [issue('<b>State</b>'), 'label-markup'],
      [issue('Unfair'), 'label-judgment'],
    ];
    for (const [panel, reason] of cases)
      expect(
        validatePictures({ pictures: [{ item: 0, panels: [panel] }] }, ITEMS)
          .dropped,
      ).toEqual([{ item: 0, reason }]);
  });

  it('allows a different ending of the same word, but not a short shared stem', () => {
    const label = (text: string) =>
      validatePictures(
        {
          pictures: [
            {
              item: 1,
              panels: [
                {
                  left: { glyphs: ['coins'], label: text },
                  link: 'none',
                },
              ],
            },
          ],
        },
        ITEMS,
      ).entries.length;
    expect(label('Reserve')).toBe(1);
    expect(label('Publishes monthly')).toBe(1);
    expect(label('Rest')).toBe(0);
  });

  it('drops panels whose shape makes no sense', () => {
    const shapes: PicturePanel[] = [
      { left: { glyphs: ['bank'] }, link: 'to' },
      { left: { glyphs: ['bank'] }, link: 'blocked' },
      {
        left: { glyphs: ['bank'] },
        link: 'none',
        right: { glyphs: ['person'] },
      },
      { left: { glyphs: ['bank'] }, link: 'none', carry: 'coins' },
      {
        left: { glyphs: ['coins'] },
        link: 'equals',
        carry: 'coins',
        right: { glyphs: ['money'] },
      },
    ];
    for (const panel of shapes)
      expect(
        validatePictures({ pictures: [{ item: 0, panels: [panel] }] }, ITEMS)
          .dropped,
      ).toEqual([{ item: 0, reason: 'shape' }]);
  });

  it('one bad panel drops the whole picture; unknown and repeated items are ignored', () => {
    const result = validatePictures(
      {
        pictures: [
          { item: 0, panels: [issue(), issue('Unsafe')] },
          { item: 7, panels: [issue()] },
          { item: 2, panels: [issue()] },
          { item: 2, panels: [issue('Holders')] },
        ],
      },
      ITEMS,
    );
    expect(result.entries.map((e) => e.item)).toEqual([2]);
    expect(result.entries[0]?.panels[0]?.stamp).toBeUndefined();
    expect(result.dropped).toEqual([
      { item: 0, reason: 'label-words' },
      { item: 7, reason: 'unknown-item' },
      { item: 2, reason: 'repeat' },
    ]);
  });

  it('closes the label holes found in review: other scripts, negation, derived words', () => {
    const items: PictureItem[] = [
      { index: 0, text: 'Banks pay 5 dollars to the state [S:sec-1].' },
      { index: 1, text: 'Issuers may pay interest to holders [S:sec-2].' },
      { index: 2, text: 'No interest is paid to holders [S:sec-3].' },
      { index: 3, text: 'Approved issuers file a bill each year [S:sec-4].' },
    ];
    const stamped = (item: number, label: string) =>
      validatePictures(
        {
          pictures: [
            {
              item,
              panels: [
                {
                  left: { glyphs: ['bank'] },
                  link: 'none',
                  stamp: { glyph: 'check', label },
                },
              ],
            },
          ],
        },
        items,
      );
    const reason = (item: number, label: string) =>
      stamped(item, label).dropped[0]?.reason;
    // Digits of any script count as numbers; fullwidth digits are the same digits.
    expect(reason(0, '９９')).toBe('label-number');
    expect(reason(0, '٩٩')).toBe('label-number');
    expect(stamped(0, '５').entries).toHaveLength(1);
    // A negation is allowed only when the item says one.
    expect(reason(1, 'No')).toBe('label-negation');
    expect(reason(1, 'No interest')).toBe('label-negation');
    expect(reason(1, 'Un-holders')).toBe('label-negation');
    expect(reason(1, "Can't pay")).toBe('label-negation');
    expect(stamped(2, 'No interest').entries).toHaveLength(1);
    // Inflections pass; other words that share a stem do not.
    expect(reason(3, 'Billion')).toBe('label-words');
    expect(reason(0, 'Statement')).toBe('label-words');
    expect(stamped(3, 'Approve').entries).toHaveLength(1);
    expect(stamped(3, 'Issuer files').entries).toHaveLength(1);
    expect(stamped(0, 'States').entries).toHaveLength(1);
  });

  it('refuses symbols, emoji and look-alike letters, and short words the item lacks', () => {
    const items: PictureItem[] = [
      { index: 0, text: 'Issuers may pay interest to holders [S:sec-2].' },
      { index: 1, text: 'Nonprofit banks pay no fee in the U.S. [S:sec-3].' },
    ];
    const reason = (item: number, label: string) =>
      validatePictures(
        {
          pictures: [
            {
              item,
              panels: [
                {
                  left: { glyphs: ['bank'] },
                  link: 'none',
                  stamp: { glyph: 'check', label },
                },
              ],
            },
          ],
        },
        items,
      ).dropped[0]?.reason;
    for (const label of ['🚫', '✗', '≠', '!', 'Nо'])
      expect(reason(0, label)).toBe('label-chars');
    expect(reason(0, 'X')).toBe('label-words');
    expect(reason(0, 'US')).toBe('label-words');
    // A hyphenated form of the item's own word is that word, not a negation.
    expect(reason(1, 'Non-profit')).toBeUndefined();
    expect(reason(1, 'U.S.')).toBeUndefined();
    expect(reason(1, 'No fee')).toBeUndefined();
    expect(reason(0, 'Pay to holders')).toBeUndefined();
  });
});
