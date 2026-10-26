import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { ReferencedCard } from './ReferencedCard.js';

afterEach(cleanup);

type Refs = Parameters<typeof ReferencedCard>[0]['externalRefs'];

test('shows nothing when there are no references', () => {
  const { container } = render(<ReferencedCard externalRefs={[]} />);
  expect(container.textContent).toBe('');
});

test('each item is one link with a small category-and-count line, and the citation is not repeated', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'section 509 of the Gramm-Leach-Bliley Act (15 U.S.C. 6809)',
          citation: '15 U.S.C. 6809',
          kind: 'us_code',
          sectionIds: ['sec-2'],
        },
      ]}
    />,
  );
  expect(
    screen.getByRole('heading', { name: 'Laws it refers to' }),
  ).toBeTruthy();
  const link = screen.getByRole<HTMLAnchorElement>('link', {
    name: '15 U.S.C. 6809',
  });
  expect(link.href).toBe(
    'https://www.govinfo.gov/link/uscode/15/6809?link-type=html',
  );
  expect(link.target).toBe('_blank');
  expect(link.rel).toBe('noopener noreferrer');
  const small = screen.getByText('Federal law · mentioned in 1 section');
  expect(small.tagName).toBe('SMALL');
  expect(small.className).toContain('muted');
  // The matched sentence and a second copy of the citation are gone.
  expect(screen.queryByText(/Gramm-Leach-Bliley/)).toBeNull();
  expect(screen.getAllByText(/15 U\.S\.C\. 6809/)).toHaveLength(1);
});

test('labels charter, city code and general-law refs by category, others by kind, with plurals', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: 'City Charter',
          kind: 'other',
          category: 'charter',
          sectionIds: ['s', 't'],
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
        { text: 'd', citation: '42 CFR 438.3', kind: 'cfr', sectionIds: ['s'] },
        {
          text: 'e',
          citation: 'Public Law 116-260',
          kind: 'public_law',
          sectionIds: ['s'],
        },
        {
          text: 'f',
          citation: 'R.C. 3501.01',
          kind: 'state_code',
          sectionIds: ['s'],
        },
        {
          text: 'g',
          citation: 'Social Security Act § 1902',
          kind: 'other',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  expect(
    screen.getByText('City charter · mentioned in 2 sections'),
  ).toBeTruthy();
  expect(screen.getByText('City code · mentioned in 1 section')).toBeTruthy();
  expect(
    screen.getAllByText('State law · mentioned in 1 section'),
  ).toHaveLength(2);
  expect(
    screen.getByText('Federal regulation · mentioned in 1 section'),
  ).toBeTruthy();
  expect(screen.getByText('Public law · mentioned in 1 section')).toBeTruthy();
  expect(screen.getByText('Other law · mentioned in 1 section')).toBeTruthy();
});

test('links only citations that map cleanly, safely', () => {
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
        {
          text: 'c',
          citation: 'Columbus City Charter',
          kind: 'other',
          category: 'charter',
          sectionIds: ['s'],
        },
        {
          text: 'd',
          citation: 'Social Security Act § 1902',
          kind: 'other',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  const links = screen.getAllByRole<HTMLAnchorElement>('link');
  expect(links.map((a) => a.href)).toEqual([
    'https://codes.ohio.gov/ohio-revised-code/section-3501.01',
    'https://codes.ohio.gov/ohio-revised-code/title-35',
  ]);
  for (const a of links) expect(a.rel).toBe('noopener noreferrer');
  expect(screen.getByText('Columbus City Charter').closest('a')).toBeNull();
});

test('lists read references first, then the most mentioned', () => {
  const refs: Refs = [
    { text: 'a', citation: '5 U.S.C. 1', kind: 'us_code', sectionIds: ['s'] },
    {
      text: 'b',
      citation: '5 U.S.C. 2',
      kind: 'us_code',
      sectionIds: ['s', 't', 'u'],
    },
    {
      text: 'c',
      citation: '5 U.S.C. 3',
      kind: 'us_code',
      sectionIds: ['s'],
      referenceId: 'ref:usc/5/3',
    },
    {
      text: 'd',
      citation: '5 U.S.C. 4',
      kind: 'us_code',
      sectionIds: ['s', 't'],
    },
  ];
  render(
    <ReferencedCard externalRefs={refs} onOpenReference={() => undefined} />,
  );
  expect(screen.getAllByRole('link').map((a) => a.textContent)).toEqual([
    '5 U.S.C. 3',
    '5 U.S.C. 2',
    '5 U.S.C. 4',
    '5 U.S.C. 1',
  ]);
});

test('a read reference opens the drawer on its ref: id, and the intro says which laws answers use', () => {
  const onOpen = vi.fn();
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: '15 U.S.C. 6809',
          kind: 'us_code',
          sectionIds: ['s'],
          referenceId: 'ref:usc/15/6809',
        },
        {
          text: 'b',
          citation: '5 U.S.C. 1',
          kind: 'us_code',
          sectionIds: ['s'],
        },
      ]}
      onOpenReference={onOpen}
    />,
  );
  expect(
    screen.getByText(/Answers can draw on the laws marked "Read"/),
  ).toBeTruthy();
  // Only the read one has the button.
  const buttons = screen.getAllByRole('button');
  expect(buttons).toHaveLength(1);
  fireEvent.click(buttons[0]!);
  expect(onOpen).toHaveBeenCalledWith('ref:usc/15/6809', buttons[0]);
});

test('with nothing read, the intro says answers do not draw on these laws', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: '5 U.S.C. 1',
          kind: 'us_code',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  expect(screen.getByText(/answers do not draw on them/)).toBeTruthy();
  expect(screen.queryByRole('button')).toBeNull();
});

test('the list keeps its list role for screen readers', () => {
  render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: '5 U.S.C. 1',
          kind: 'us_code',
          sectionIds: ['s'],
        },
      ]}
    />,
  );
  expect(screen.getAllByRole('list')).toHaveLength(1);
});

// reading.css scopes the compact list styling to `.refs`; without this class the rule would
// silently stop applying (or, if widened again, shrink lists in summaries and answers).
test('marks its section with the refs class the list styling is scoped to', () => {
  const { container } = render(
    <ReferencedCard
      externalRefs={[
        {
          text: 'a',
          citation: 'R.C. 3501.01',
          kind: 'state_code',
          sectionIds: ['s1'],
        },
      ]}
    />,
  );
  expect(container.querySelector('section.card.refs ul')).toBeTruthy();
});
