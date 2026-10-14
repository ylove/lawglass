import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { officialUrl, ReferencedCard } from './ReferencedCard.js';

afterEach(cleanup);

test('labels charter, city code and general-law refs by category, others by kind', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: 'City Charter',
          kind: 'other',
          category: 'charter',
          sectionIds: ['s'],
        },
        {
          text: 'b',
          citation: 'City Code § 1',
          kind: 'other',
          category: 'local_code',
          sectionIds: ['s'],
        },
        {
          text: 'c',
          citation: 'Ohio Revised Code, Title 35',
          kind: 'other',
          category: 'general_law',
          sectionIds: ['s'],
        },
        {
          text: 'd',
          citation: '5 U.S.C. 1',
          kind: 'us_code',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  expect(screen.getByText('(City charter)')).toBeTruthy();
  expect(screen.getByText('(City code)')).toBeTruthy();
  expect(screen.getByText('(State law)')).toBeTruthy();
  expect(screen.getByText('(Federal law)')).toBeTruthy();
  // Only the Title 35 ref maps to an official site; charter, city code and federal get none.
  expect(screen.getAllByRole('link')).toHaveLength(1);
});

test('links Ohio Revised Code refs to codes.ohio.gov, safely', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: 'R.C. 3501.01',
          kind: 'state_code',
          sectionIds: ['s'],
        },
        {
          text: 'b',
          citation: 'Ohio Revised Code, Title 35',
          kind: 'other',
          category: 'general_law',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  const [one, two] = screen.getAllByRole<HTMLAnchorElement>('link');
  expect(one?.href).toBe(
    'https://codes.ohio.gov/ohio-revised-code/section-3501.01',
  );
  expect(two?.href).toBe('https://codes.ohio.gov/ohio-revised-code/title-35');
  for (const a of [one, two]) {
    expect(a?.target).toBe('_blank');
    expect(a?.rel).toBe('noopener noreferrer');
  }
});

test('officialUrl maps only clean Ohio citations and never builds a search link', () => {
  expect(officialUrl('R.C. Chapter 3501')).toBe(
    'https://codes.ohio.gov/ohio-revised-code/chapter-3501',
  );
  expect(officialUrl('R.C. 5747.01 to 5747.05')).toBeUndefined();
  expect(officialUrl('Columbus City Charter')).toBeUndefined();
  expect(officialUrl('R.C. 1.1/../x')).toBeUndefined();
  expect(officialUrl('42 U.S.C. 1983')).toBeUndefined();
});
