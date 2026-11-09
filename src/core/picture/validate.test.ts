import { describe, expect, it } from 'vitest';
import type { PicturePanel, StampId } from '../model/index.js';
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

  const stampCases: [StampId, string[], string[]][] = [
    [
      'warning',
      [
        'penalties',
        'penalty',
        'penalized',
        'penalised',
        'fine',
        'fines',
        'fined',
        'violations',
        'sanctions',
        'liability',
        'risk',
        'revoked',
        'revocation',
        'suspended',
        'prison',
        'imprisonment',
        'civil action',
        'forfeiture',
        'break the rule',
        'break a law',
        'breaks the rules',
        'breach of the law',
        'breached a regulation',
        'criminal',
        'criminal charge',
        'criminal charges',
        'face a criminal charge',
        'faces criminal charges',
        'charged with a crime',
        'charges for an offense',
        'may be shut down',
        'cease-and-desist order',
        'cease and desist order',
        'who break the rule pay up to $100,000',
        'who break a condition pay up to $100,000',
        'who violate a condition pay up to $100,000',
        'who fail to report pay up to $100,000',
        'who noncomply pay up to $100,000',
        'who fail to report face up to $100,000',
        'pay up to $100,000 if they fail to report',
      ],
      [
        'finance',
        'refined',
        'privileged',
        'enforcement',
        'The Treasury enforces the rule on states, and banks file reports',
        'enforce the rules',
        'enforced the rules',
        'enforcing the rules',
        'break ground',
        'breach of confidence',
        'charge fees',
        'charges for services',
        'face charges for services',
        'charged with oversight',
        'pay up to $100,000 for supplies',
        'receive grants of up to $100,000',
        'fail to report. Grants are up to $100,000',
      ],
    ],
    [
      'seal',
      [
        'approved',
        'licensed',
        'chartered',
        'certified',
        'registered',
        'authorized',
        'authorised',
        'authorisation',
        'permitted',
        'regulated',
        'supervised',
        'accredited',
        'oversee',
        'oversees',
        'overseen',
        'oversight',
      ],
      ['disapproval', 'unregistered', 'records', 'overseas', 'overlooked'],
    ],
    [
      'no',
      [
        'no',
        'not',
        'non',
        'un',
        'never',
        'none',
        'nor',
        'without',
        'cannot',
        "can't",
        'isn’t',
        'prohibited',
        'ban',
        'bans',
        'banned',
        'forbidden',
        'bar',
        'bars',
        'barred',
        'may not',
        'shall not',
        'must not',
      ],
      ['notice', 'nonprofit', 'bank', 'bargain'],
    ],
    [
      'calendar',
      [
        'days',
        'monthly',
        'years',
        'deadline',
        'within',
        'annually',
        'quarterly',
        'weeks',
        'hours',
      ],
      [
        'someday',
        'updated',
        'thereafter',
        'date',
        'effective',
        'period',
        'before',
        'after',
      ],
    ],
    [
      'clock',
      [
        'days',
        'monthly',
        'years',
        'deadline',
        'within',
        'annually',
        'quarterly',
        'weeks',
        'hours',
        'promptly',
        'immediately',
        'without delay',
        'as soon as practicable',
      ],
      [
        'someday',
        'updated',
        'thereafter',
        'date',
        'effective',
        'period',
        'before',
        'after',
        'prompt reports',
        'immediate supervisor',
        'delays',
      ],
    ],
    [
      'check',
      [
        'may',
        'must',
        'shall',
        'can',
        'able',
        'requires',
        'allowed',
        'permitted',
        'eligible',
        'entitled',
        'authorized',
        'authorised',
      ],
      ['mayor', 'mustard', 'shallow', 'candy', 'disabled', 'unauthorised'],
    ],
  ];

  for (const [glyph, supported, unsupported] of stampCases)
    it(`requires the item's own words to support a ${glyph} stamp, even without a label`, () => {
      const reason = (
        text: string,
        panel: PicturePanel = {
          left: { glyphs: ['bank'] },
          link: 'none',
          stamp: { glyph },
        },
      ) =>
        validatePictures({ pictures: [{ item: 0, panels: [panel] }] }, [
          { index: 0, text },
        ]).dropped[0]?.reason;

      for (const word of supported)
        expect(
          reason(`Banks: ${word.toUpperCase()} [S:sec-1].`),
          word,
        ).toBeUndefined();
      for (const word of unsupported)
        expect(reason(`Banks send ${word} reports.`), word).toBe(
          'stamp-unsupported',
        );
      // Citation ids and labels cannot supply the claim missing from the caption.
      expect(reason(`Banks send reports [S:${supported[0]!}].`)).toBe(
        'stamp-unsupported',
      );
      expect(
        reason('Banks send reports.', {
          left: { glyphs: ['bank'] },
          link: 'none',
          stamp: { glyph, label: supported[0]! },
        }),
      ).toBe('stamp-unsupported');
      expect(reason('Banks send reports.')).toBe('stamp-unsupported');
      expect(
        reason('Banks send reports.', {
          left: { glyphs: ['bank'] },
          link: 'none',
        }),
      ).toBeUndefined();
      expect(
        reason('Banks send reports.', {
          left: { glyphs: ['bank'] },
          link: 'to',
          stamp: { glyph },
        }),
      ).toBe('shape');
    });

  for (const glyph of ['calendar', 'clock'] as const) {
    const timingCases: [string, boolean][] = [
      ...[
        'January',
        'February',
        'March',
        'April',
        'May',
        'June',
        'July',
        'August',
        'September',
        'October',
        'November',
        'December',
      ].map((month): [string, boolean] => [
        `Banks report by ${month} 1.`,
        true,
      ]),
      ['Banks report by 2027.', true],
      ['Banks report by 1999.', true],
      ['Banks report in 2000.', true],
      ['Banks report by 12/31.', true],
      ['Banks report no later than enactment.', true],
      ['Banks report not later than enactment.', true],
      ['Banks report before 30 days have passed.', true],
      ['Banks report after the first 30 days.', true],
      ['Banks report before the first 30.', true],
      ['Banks report after the first 30.', true],
      ['Banks report after consultation with the Fed.', false],
      ['Banks report before consultation with the Fed.', false],
      [
        'Banks report before the first formal consultation about article 30.',
        false,
      ],
      [
        'Banks report after the first formal consultation about article 30.',
        false,
      ],
      ['Banks date the reports.', false],
      ['Banks have effective controls for a transition period.', false],
      ['Banks report by mail.', false],
      ['Banks may issue coins.', false],
      ['Banks cite rule 20270.', false],
      ['Banks cite rule 1899.', false],
      ['Banks cite rule 2100.', false],
    ];
    it.each(timingCases)(
      `checks timing context for ${glyph}: %s (%s)`,
      (text, supported) => {
        const result = validatePictures(
          {
            pictures: [
              {
                item: 0,
                panels: [
                  {
                    left: { glyphs: ['bank'] },
                    link: 'none',
                    stamp: { glyph },
                  },
                ],
              },
            ],
          },
          [{ index: 0, text }],
        );
        expect(result.entries).toHaveLength(supported ? 1 : 0);
        expect(result.dropped).toEqual(
          supported ? [] : [{ item: 0, reason: 'stamp-unsupported' }],
        );
      },
    );
  }

  it.each([
    'Issuers may not issue coins.',
    'Issuers shall not pay interest.',
    'Issuers must not pay interest.',
    'Issuers are prohibited from issuing coins but may file reports.',
    'Issuers cannot issue coins but must file reports.',
    'Issuers are forbidden to issue coins but can file reports.',
    'Issuers are banned from issuing coins but are entitled to file reports.',
    'Issuers are barred from issuing coins but are authorised to file reports.',
    'Issuers are not allowed to issue coins.',
  ])('refuses a check and accepts a no stamp on a prohibition: %s', (text) => {
    for (const glyph of ['check', 'no'] as const) {
      const result = validatePictures(
        {
          pictures: [
            {
              item: 0,
              panels: [
                {
                  left: { glyphs: ['bank'] },
                  link: 'none',
                  stamp: { glyph },
                },
              ],
            },
          ],
        },
        [{ index: 0, text }],
      );
      expect(result.entries).toHaveLength(glyph === 'no' ? 1 : 0);
      expect(result.dropped).toEqual(
        glyph === 'no' ? [] : [{ item: 0, reason: 'stamp-unsupported' }],
      );
    }
  });

  it.each([
    ['seal', 'Issuers are licen\u00adsed.', 'Licensed'],
    ['warning', 'Issuers face penal\u00adties.', 'Penalties'],
    ['seal', 'Issuers are licen\u200bsed.', 'Licen\u200bsed'],
    ['seal', 'Issuers are auth\u200dorised.', 'Authorised'],
    ['warning', 'Issuers face penal\u2060ties.', 'Penal\u2060ties'],
    ['calendar', 'Issuers report each ｙｅａｒ.', 'Year'],
  ] as const)(
    'normalizes invisible format characters and NFKC: %s, %s',
    (glyph, text, label) => {
      const result = validatePictures(
        {
          pictures: [
            {
              item: 0,
              panels: [
                {
                  left: { glyphs: ['bank'], label },
                  link: 'none',
                  stamp: { glyph },
                },
              ],
            },
          ],
        },
        [{ index: 0, text }],
      );
      expect(result.dropped).toEqual([]);
      expect(result.entries).toHaveLength(1);
    },
  );

  it('does not let format characters hide a prohibition from a check', () => {
    const result = validatePictures(
      {
        pictures: [
          {
            item: 0,
            panels: [
              {
                left: { glyphs: ['bank'] },
                link: 'none',
                stamp: { glyph: 'check' },
              },
            ],
          },
        ],
      },
      [{ index: 0, text: 'Issuers may n\u00adot pay interest.' }],
    );
    expect(result.dropped).toEqual([{ item: 0, reason: 'stamp-unsupported' }]);
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
      { index: 0, text: 'Banks must pay 5 dollars to the state [S:sec-1].' },
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
                  stamp: {
                    glyph: item === 2 ? 'no' : item === 3 ? 'seal' : 'check',
                    label,
                  },
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
                  stamp: { glyph: item === 1 ? 'no' : 'check', label },
                },
              ],
            },
          ],
        },
        items,
      ).dropped[0]?.reason;
    for (const label of ['🚫', '✗', '≠', '!', 'Nо', '$', '-', '%', '()', '.'])
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
