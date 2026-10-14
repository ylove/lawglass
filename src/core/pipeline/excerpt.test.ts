import { expect, test } from 'vitest';
import { AppError, type Section } from '../model/index.js';
import { makeAmendingBillPdf } from '../../../tests/synth/index.js';
import { breadcrumbFor, findSectionPath, sectionExcerpt } from './excerpt.js';

const sections: Section[] = [
  {
    id: 'sec-4',
    num: '4',
    heading: 'Grants',
    level: 1,
    spans: [{ text: 'Lead-in.', status: 'unchanged' }],
    children: [
      {
        id: 'sec-4/a',
        num: '(a)',
        heading: 'Eligibility',
        level: 2,
        spans: [
          { text: 'Towns qualify', status: 'unchanged' },
          { text: ' old rule', status: 'deleted' },
        ],
        children: [
          {
            id: 'sec-4/a/1',
            num: '(1)',
            level: 3,
            spans: [{ text: 'Nested text.', status: 'inserted' }],
            children: [],
          },
        ],
      },
      { id: 'sec-4/b', num: '(b)', level: 2, spans: [], children: [] },
    ],
  },
];

test('a parent excerpt includes descendants in order, each prefixed with num and heading', () => {
  const excerpt = sectionExcerpt({ sections }, 'sec-4');
  expect(excerpt.spans.map((s) => s.text).join('')).toBe(
    'Lead-in.\n\n(a) Eligibility. Towns qualify old rule\n\n(1). Nested text.\n\n(b). ',
  );
  // Struck and inserted status survive for the drawer's styling.
  expect(excerpt.spans.map((s) => s.status)).toContain('deleted');
  expect(excerpt.spans.map((s) => s.status)).toContain('inserted');
  expect(excerpt.breadcrumb).toBe('Sec. 4 Grants');
  expect(excerpt.num).toBe('4');
  expect(excerpt.heading).toBe('Grants');
});

test('a leaf excerpt has only its own text and a full breadcrumb', () => {
  const excerpt = sectionExcerpt({ sections }, 'sec-4/a/1');
  expect(excerpt.spans).toEqual([{ text: 'Nested text.', status: 'inserted' }]);
  expect(excerpt.breadcrumb).toBe('Sec. 4 Grants > (a) Eligibility > (1)');
  expect(excerpt.location).toEqual({});
});

test('an empty parent does not start with a separator', () => {
  const excerpt = sectionExcerpt(
    {
      sections: [
        {
          id: 'sec-1',
          num: '1',
          level: 1,
          spans: [],
          children: [
            {
              id: 'sec-1/a',
              num: '(a)',
              level: 2,
              spans: [{ text: 'x', status: 'unchanged' }],
              children: [],
            },
          ],
        },
      ],
    },
    'sec-1',
  );
  expect(excerpt.spans.map((s) => s.text).join('')).toBe('(a). x');
});

test('unknown sections are an AppError', () => {
  expect(() => sectionExcerpt({ sections }, 'sec-99')).toThrow(AppError);
  expect(findSectionPath(sections, 'sec-99')).toBeUndefined();
  expect(breadcrumbFor([{ id: 'x', level: 1, spans: [], children: [] }])).toBe(
    'x',
  );
});

test('location comes from the spans of the section and its descendants', async () => {
  const pdf = await makeAmendingBillPdf();
  const excerpt = sectionExcerpt(pdf.groundTruth, 'sec-5747.01');
  expect(excerpt.location.pageStart).toBe(1);
  expect(excerpt.location.lineStart).toBeGreaterThan(0);
  // The parent has no spans of its own; the children's text is still present.
  expect(excerpt.spans.map((s) => s.text).join('')).toContain(
    'As used in this chapter:',
  );
});

test('without span positions the section own location is used', () => {
  const excerpt = sectionExcerpt(
    {
      sections: [
        {
          id: 'sec-1',
          level: 1,
          spans: [{ text: 'x', status: 'unchanged' }],
          children: [],
          pageStart: 2,
          pageEnd: 3,
          lineStart: 4,
          lineEnd: 5,
        },
      ],
    },
    'sec-1',
  );
  expect(excerpt.location).toEqual({
    pageStart: 2,
    pageEnd: 3,
    lineStart: 4,
    lineEnd: 5,
  });
  expect(excerpt.breadcrumb).toBe('sec-1');
});
