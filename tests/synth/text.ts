import type { SyntheticSample } from './types.js';

/** Every section-detection example in spec §5.2, plus federal uppercase SEC. */
export function makeSectionedText(): SyntheticSample {
  return {
    bytes: new TextEncoder().encode(
      [
        'Synthetic Community Gardens Bill',
        'Section 1. Short title',
        'This act may be cited as the Community Gardens Act.',
        'SECTION 2. Grants',
        'The department shall award grants for shared gardens.',
        'Sec. 101. Definitions',
        'As used in this section:',
        '(a) Eligible applicants',
        '(1) "Garden group" means a group maintaining a shared garden.',
        '(A) A group shall keep a public planting schedule.',
        '§ 5747.01 Reporting',
        'Each grantee shall file an annual report.',
        'SEC. 3. Effective date',
        'This act takes effect ninety days after passage.',
        '',
      ].join('\n'),
    ),
    groundTruth: {
      deletedStrings: [],
      insertedStrings: [],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Short title',
          level: 1,
          spans: [
            {
              text: 'This act may be cited as the Community Gardens Act.',
              status: 'unchanged',
            },
          ],
          children: [],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Grants',
          level: 1,
          spans: [
            {
              text: 'The department shall award grants for shared gardens.',
              status: 'unchanged',
            },
          ],
          children: [],
        },
        {
          id: 'sec-101',
          num: '101',
          heading: 'Definitions',
          level: 1,
          spans: [{ text: 'As used in this section:', status: 'unchanged' }],
          children: [
            {
              id: 'sec-101/a',
              num: '(a)',
              heading: 'Eligible applicants',
              level: 2,
              spans: [],
              children: [
                {
                  id: 'sec-101/a/1',
                  num: '(1)',
                  level: 3,
                  spans: [
                    {
                      text: '"Garden group" means a group maintaining a shared garden.',
                      status: 'unchanged',
                    },
                  ],
                  children: [
                    {
                      id: 'sec-101/a/1/A',
                      num: '(A)',
                      level: 4,
                      spans: [
                        {
                          text: 'A group shall keep a public planting schedule.',
                          status: 'unchanged',
                        },
                      ],
                      children: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'sec-5747.01',
          num: '5747.01',
          heading: 'Reporting',
          level: 1,
          spans: [
            {
              text: 'Each grantee shall file an annual report.',
              status: 'unchanged',
            },
          ],
          children: [],
        },
        {
          id: 'sec-3',
          num: '3',
          heading: 'Effective date',
          level: 1,
          spans: [
            {
              text: 'This act takes effect ninety days after passage.',
              status: 'unchanged',
            },
          ],
          children: [],
        },
      ],
    },
  };
}
