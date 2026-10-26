import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import type { BillHistory } from '../../core/model/index.js';
import {
  AmendmentsCard,
  describeAmendment,
  groupBySponsor,
} from './AmendmentsCard.js';

afterEach(cleanup);

type Amendment = BillHistory['amendments'][number];

const history = (amendments: Amendment[]): BillHistory => ({
  versions: [],
  actions: [],
  amendments,
  sources: [],
});

/** Shaped like S.1582: one sponsor with 38, several with fewer, a few with none recorded. */
function senateFixture(): Amendment[] {
  const out: Amendment[] = [];
  let n = 0;
  const add = (
    sponsor: string | undefined,
    count: number,
    statuses: Amendment['status'][] = [],
  ) => {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      out.push({
        id: `119samdt${String(n)}`,
        number: String(n),
        status: statuses[i] ?? 'unknown',
        ...(sponsor ? { sponsor: { name: sponsor } } : {}),
      });
    }
  };
  // Paul: 38 amendments, 3 withdrawn and 1 adopted among them.
  add('Sen. Paul, Rand [R-KY]', 38, [
    'adopted',
    'withdrawn',
    'withdrawn',
    'withdrawn',
  ]);
  add('Sen. Lee, Mike [R-UT]', 20);
  add('Sen. Scott, Rick [R-FL]', 15);
  add('Sen. Schumer, Charles E. [D-NY]', 12);
  add('Sen. Warren, Elizabeth [D-MA]', 9);
  add('Sen. Kennedy, John [R-LA]', 8);
  add('Sen. Johnson, Ron [R-WI]', 7);
  add('Sen. Hawley, Josh [R-MO]', 6);
  add('Sen. Murray, Patty [D-WA]', 5);
  add('Sen. Wyden, Ron [D-OR]', 4);
  add('Sen. King, Angus [I-ME]', 3);
  add('Sen. Cruz, Ted [R-TX]', 1);
  add(undefined, 2);
  return out;
}

describe('AmendmentsCard', () => {
  test('renders nothing without amendments', () => {
    const { container } = render(<AmendmentsCard history={history([])} />);
    expect(container.textContent).toBe('');
    const none = render(<AmendmentsCard history={undefined} />);
    expect(none.container.textContent).toBe('');
  });

  test('130 amendments are counted per sponsor, not listed', () => {
    const all = senateFixture();
    expect(all).toHaveLength(130);
    render(
      <AmendmentsCard
        history={history(all)}
        allAmendmentsUrl="https://www.congress.gov/bill/119th-congress/senate-bill/1582/amendments"
      />,
    );
    const card = screen.getByRole('region', { name: 'Amendments' });
    expect(
      within(card).getByText('130 amendments from 12 sponsors'),
    ).toBeTruthy();
    // The top sponsor leads, with a tally of the known statuses only.
    const first = within(card).getAllByRole('listitem')[0]!;
    expect(first.textContent).toContain(
      'Sen. Paul, Rand [R-KY] · 38 amendments',
    );
    expect(first.textContent).toContain('(1 adopted, 3 withdrawn)');
    expect(
      within(card).getByText('Sen. Lee, Mike [R-UT] · 20 amendments'),
    ).toBeTruthy();
    // No per-amendment lines.
    expect(within(card).queryByText(/Amendment 1\b/)).toBeNull();
    // Unsponsored amendments are one honest row.
    expect(
      within(card).getByText('No sponsor recorded · 2 amendments'),
    ).toBeTruthy();
    expect(
      within(card)
        .getByRole('link', {
          name: /See all 130 amendments on Congress\.gov/,
        })
        .getAttribute('href'),
    ).toBe(
      'https://www.congress.gov/bill/119th-congress/senate-bill/1582/amendments',
    );
    expect(
      within(card).getByText(
        /People are named only when the record names them/,
      ),
    ).toBeTruthy();
  });

  test('only the top 8 sponsors are open; the rest fold into a details disclosure', () => {
    render(<AmendmentsCard history={history(senateFixture())} />);
    const card = screen.getByRole('region', { name: 'Amendments' });
    const details = card.querySelector('details')!;
    expect(details).toBeTruthy();
    expect(within(details).getByText('Show 4 more sponsors')).toBeTruthy();
    expect(details.textContent).toContain(
      'Sen. Cruz, Ted [R-TX] · 1 amendment',
    );
    expect(details.textContent).not.toContain('Sen. Paul');
    // 8 visible sponsors + the no-sponsor row sit outside the disclosure.
    const outside = within(card)
      .getAllByRole('listitem')
      .filter((li) => !details.contains(li));
    expect(outside).toHaveLength(9);
    // A details summary is not a button, so the card stays button-free.
    expect(within(card).queryByRole('button')).toBeNull();
    // No official link known: no "See all" line.
    expect(within(card).queryByRole('link')).toBeNull();
  });

  test('few sponsors need no disclosure, and singular counts read correctly', () => {
    const items: Amendment[] = Array.from({ length: 7 }, (_, i) => ({
      id: `a${String(i)}`,
      status: 'unknown',
      sponsor: { name: 'Rep. A. One' },
    }));
    render(<AmendmentsCard history={history(items)} />);
    const card = screen.getByRole('region', { name: 'Amendments' });
    expect(within(card).getByText('7 amendments from 1 sponsor')).toBeTruthy();
    expect(card.querySelector('details')).toBeNull();
    // "unknown" is never counted as a status.
    expect(card.textContent).not.toContain('(');
  });

  test('up to six amendments are listed one by one, linked when the record has a url', () => {
    render(
      <AmendmentsCard
        history={history([
          {
            id: 'x1',
            number: '12',
            status: 'adopted',
            date: '2026-03-10',
            sponsor: { name: 'Rep. J. Chen' },
            committee: 'House Water Committee',
            purpose: 'To fund inspections',
            url: 'https://www.congress.gov/amendment/119th-congress/house-amendment/12',
          },
          { id: 'x2', number: '13', status: 'rejected' },
        ])}
      />,
    );
    const card = screen.getByRole('region', { name: 'Amendments' });
    const link = within(card).getByRole('link', { name: /Amendment 12/ });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(card.textContent).toContain('Adopted, ');
    expect(card.textContent).toContain(
      'by Rep. J. Chen (House Water Committee): To fund inspections',
    );
    expect(within(card).getByText('Amendment 13')).toBeTruthy();
    expect(within(card).getByText('Rejected')).toBeTruthy();
  });

  test('Ohio amendments do not repeat their own number', () => {
    render(
      <AmendmentsCard
        history={history([
          {
            id: 'am123',
            number: 'am123',
            status: 'unknown',
            sponsor: { name: 'Rep. Smith' },
            description: 'Amendment am123 (136_HB1_IN)',
            url: 'https://search-prod.lis.state.oh.us/api/v2/general_assembly_136/legislation/hb1/amendments/am123/pdf/',
          },
          {
            id: 'am124',
            number: 'am124',
            status: 'unknown',
            sponsor: { name: 'Rep. Jones' },
            description:
              'Amendment am124 (136_HB1_IN). Also sponsored by Rep. Lee',
          },
        ])}
      />,
    );
    const card = screen.getByRole('region', { name: 'Amendments' });
    expect(card.textContent).toContain(
      'Amendment am123 (opens in a new tab) (136_HB1_IN) by Rep. Smith',
    );
    expect(card.textContent).not.toMatch(/am123.*am123.*am123/);
    expect(card.textContent).toContain(
      'Amendment am124 (136_HB1_IN) by Rep. Jones: Also sponsored by Rep. Lee',
    );
  });
});

describe('describeAmendment', () => {
  const base: Amendment = { id: 'a', number: 'am1', status: 'unknown' };
  test('prefers the purpose and keeps descriptions that say more than the number', () => {
    expect(
      describeAmendment({ ...base, purpose: 'P', description: 'D' }),
    ).toEqual({ detail: 'P' });
    expect(
      describeAmendment({ ...base, description: 'Amendment am1' }),
    ).toEqual({});
    expect(
      describeAmendment({ ...base, description: 'A different note' }),
    ).toEqual({
      detail: 'A different note',
    });
    expect(describeAmendment(base)).toEqual({});
  });
});

describe('groupBySponsor', () => {
  test('sorts by count then name and keeps names exactly as recorded', () => {
    const { named, unsponsored } = groupBySponsor([
      { id: '1', status: 'adopted', sponsor: { name: 'B' } },
      { id: '2', status: 'unknown', sponsor: { name: 'A' } },
      { id: '3', status: 'unknown', sponsor: { name: 'A' } },
      { id: '4', status: 'rejected', sponsor: { name: 'C' } },
      { id: '5', status: 'unknown' },
    ]);
    expect(named.map((g) => `${g.name}:${String(g.count)}`)).toEqual([
      'A:2',
      'B:1',
      'C:1',
    ]);
    expect(unsponsored?.count).toBe(1);
  });
});
