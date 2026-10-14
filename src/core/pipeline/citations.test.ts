import { expect, test } from 'vitest';
import type { Citation, Section } from '../model/index.js';
import { formatCitation, formatLocation } from './citations.js';

const sections: Section[] = [
  {
    id: 'sec-4',
    num: '4',
    level: 1,
    spans: [],
    children: [
      {
        id: 'sec-4/b',
        num: '(b)',
        level: 2,
        spans: [],
        children: [
          { id: 'sec-4/b/2', num: '(2)', level: 3, spans: [], children: [] },
        ],
      },
      { id: 'sec-4/x', num: 'Note', level: 2, spans: [], children: [] },
      { id: 'sec-4/y', level: 2, spans: [], children: [] },
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

test('formats section, page and lines', () => {
  expect(
    formatCitation(
      cite('sec-4', { pageStart: 3, pageEnd: 3, lineStart: 12, lineEnd: 18 }),
      { sections },
    ),
  ).toBe('Sec. 4, p. 3, lines 12–18');
});

test('nested enumerators attach to the section number', () => {
  expect(formatCitation(cite('sec-4/b/2'), { sections })).toBe('Sec. 4(b)(2)');
  expect(formatCitation(cite('sec-4/x'), { sections })).toBe('Sec. 4 > Note');
  expect(formatCitation(cite('sec-4/y'), { sections })).toBe('Sec. 4');
});

test('XML and HTML citations are section-only', () => {
  expect(formatCitation(cite('sec-4'), { sections })).toBe('Sec. 4');
});

test('multi-page and single-line ranges', () => {
  expect(
    formatLocation({ pageStart: 1, pageEnd: 2, lineStart: 5, lineEnd: 5 }),
  ).toBe('pp. 1–2, line 5');
  expect(formatLocation({ pageStart: 1 })).toBe('p. 1');
  expect(formatLocation(undefined)).toBe('');
});

test('unknown sections fall back to the id', () => {
  expect(formatCitation(cite('sec-99'), { sections })).toBe('sec-99');
});
