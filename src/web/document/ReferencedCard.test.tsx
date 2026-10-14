import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { ReferencedCard } from './ReferencedCard.js';

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
  expect(screen.queryByRole('link')).toBeNull();
});
