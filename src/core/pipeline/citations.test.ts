import { expect, test } from 'vitest';
import type { Citation, Section } from '../model/index.js';
import { formatCitation, formatLocation } from './citations.js';

const span = (page?: number, line?: number) => [
  {
    text: 'x',
    status: 'unchanged' as const,
    ...(page === undefined ? {} : { page }),
    ...(line === undefined ? {} : { line }),
  },
];
const sections: Section[] = [
  {
    id: 'sec-4',
    num: '4',
    level: 1,
    spans: span(3, 12),
    children: [
      {
        id: 'sec-4/b',
        num: '(b)',
        level: 2,
        spans: span(3, 20),
        children: [
          {
            id: 'sec-4/b/2',
            num: '(2)',
            level: 3,
            spans: [
              { text: 'a', status: 'unchanged', page: 3, line: 20 },
              { text: 'b', status: 'unchanged', page: 4, line: 5 },
            ],
            children: [],
          },
        ],
      },
      { id: 'sec-4/x', num: 'Note', level: 2, spans: [], children: [] },
      { id: 'sec-4/y', level: 2, spans: [], children: [] },
    ],
  },
  {
    id: 'division-D',
    num: 'D',
    level: 1,
    spans: [],
    children: [
      {
        id: 'title-XLI',
        num: 'XLI',
        level: 2,
        spans: [],
        children: [
          { id: 'sec-4101', num: '4101', level: 3, spans: [], children: [] },
        ],
      },
    ],
  },
];
const cite = (
  sectionId: string,
  location?: Citation['location'],
): Citation => ({
  sectionId,
  valid: true,
  chunkIds: [],
  ...(location ? { location } : {}),
});

test('formats section, page and line from the shown excerpt', () => {
  expect(formatCitation(cite('sec-4'), { sections })).toBe(
    'Sec. 4, p. 3, line 12',
  );
});

test('the location ignores the chunk range the model saw (CLI agrees with the drawer)', () => {
  const wide = { pageStart: 1, pageEnd: 9, lineStart: 1, lineEnd: 99 };
  expect(formatCitation(cite('sec-4', wide), { sections })).toBe(
    'Sec. 4, p. 3, line 12',
  );
});

test('nested enumerators attach and ranges across a page break show both pages', () => {
  expect(formatCitation(cite('sec-4/b/2'), { sections })).toBe(
    'Sec. 4(b)(2), p. 3, line 20 – p. 4, line 5',
  );
  expect(formatCitation(cite('sec-4/x'), { sections })).toBe('Sec. 4 > Note');
  expect(formatCitation(cite('sec-4/y'), { sections })).toBe('Sec. 4');
});

test('federal divisions and titles above a section are left out', () => {
  expect(formatCitation(cite('sec-4101'), { sections })).toBe('Sec. 4101');
  expect(formatCitation(cite('title-XLI'), { sections })).toBe('Title XLI');
  expect(formatCitation(cite('division-D'), { sections })).toBe('Division D');
});

test('XML and HTML citations are section-only', () => {
  const xml: Section[] = [
    { id: 'sec-1', num: '1', level: 1, spans: [], children: [] },
  ];
  expect(formatCitation(cite('sec-1'), { sections: xml })).toBe('Sec. 1');
});

test('location formats', () => {
  expect(
    formatLocation({ pageStart: 3, pageEnd: 3, lineStart: 12, lineEnd: 18 }),
  ).toBe('p. 3, lines 12–18');
  expect(formatLocation({ pageStart: 1, pageEnd: 2 })).toBe('pp. 1–2');
  expect(formatLocation({ pageStart: 1 })).toBe('p. 1');
  expect(formatLocation({ lineStart: 4, lineEnd: 6 })).toBe('lines 4–6');
  expect(formatLocation(undefined)).toBe('');
  expect(formatLocation({})).toBe('');
});

test('unknown sections fall back to the id and the citation location', () => {
  expect(formatCitation(cite('sec-99'), { sections })).toBe('sec-99');
  expect(
    formatCitation(cite('sec-99', { pageStart: 2, pageEnd: 2 }), { sections }),
  ).toBe('sec-99, p. 2');
});

test('a reference citation prints the law and its source, not the bare id', () => {
  const reference = {
    sectionId: 'ref:usc/15/6809',
    citation: '15 U.S.C. 6809',
    sourceUrl: 'https://www.govinfo.gov/link/uscode/15/6809?link-type=html',
    text: 'x',
    terms: ['financial institution'],
    fetchedAt: '2026-10-26T00:00:00.000Z',
  };
  const line = formatCitation(
    { sectionId: reference.sectionId, valid: true, chunkIds: [] },
    { sections, references: [reference] },
  );
  expect(line).toBe(
    "15 U.S.C. 6809 (U.S. Code, read for 'financial institution'), https://www.govinfo.gov/link/uscode/15/6809?link-type=html",
  );
  expect(
    formatCitation(
      { sectionId: 'ref:usc/1/1', valid: true, chunkIds: [] },
      { sections },
    ),
  ).toBe('ref:usc/1/1');
});

test('a quoted statute section reads "quoted § N", and a PART bill names its part', () => {
  const bill: Section[] = [
    {
      id: 'sec-1',
      num: '1',
      heading: 'Part A. Short title.',
      level: 1,
      spans: [],
      children: [
        {
          id: 'sec-1/1509',
          num: '§ 1509',
          level: 2,
          spans: [],
          children: [
            {
              id: 'sec-1/1509/1',
              num: '(1)',
              level: 3,
              spans: [],
              children: [],
            },
          ],
        },
      ],
    },
    {
      id: 'sec-1~2',
      num: '1',
      heading: 'Part B',
      level: 1,
      spans: [],
      children: [],
    },
  ];
  expect(formatCitation(cite('sec-1/1509'), { sections: bill })).toBe(
    'Sec. 1 of Part A, quoted § 1509',
  );
  expect(formatCitation(cite('sec-1/1509/1'), { sections: bill })).toBe(
    'Sec. 1 of Part A, quoted § 1509(1)',
  );
  expect(formatCitation(cite('sec-1~2'), { sections: bill })).toBe(
    'Sec. 1 of Part B',
  );
});
