import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BreakdownResponse } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { createMockApi } from '../mock-api.js';
import { BreakdownPanel } from './BreakdownPanel.js';
import { syntheticBill } from './synthetic-bill.js';

afterEach(cleanup);

const DOC = 'a'.repeat(64);

function scripted(responses: BreakdownResponse[]) {
  const api = createMockApi({ delayMs: 0 });
  const getBreakdown = vi.fn<ApiClient['getBreakdown']>(() =>
    Promise.resolve(
      (responses.length > 1 ? responses.shift() : responses[0]) ?? {
        status: 'disabled' as const,
      },
    ),
  );
  api.getBreakdown = getBreakdown;
  const pictures = vi.fn<ApiClient['getBreakdownPictures']>(() =>
    Promise.resolve({ status: 'none' as const }),
  );
  api.getBreakdownPictures = pictures;
  return Object.assign(api, { spy: { breakdown: getBreakdown, pictures } });
}

const panel = (api: ApiClient, outline = syntheticBill().outline) =>
  render(
    <BreakdownPanel
      api={api}
      docId={DOC}
      enabled
      outline={outline}
      onOpenSection={() => undefined}
      pollMs={5}
      maxWaitMs={500}
      examplePollMs={5}
      exampleMaxWaitMs={5000}
      coolDownMs={5}
    />,
  );

describe('progress', () => {
  test('says how many sections are ready, with thousands separators, while it polls', async () => {
    const { briefs } = syntheticBill();
    const api = scripted([
      { status: 'pending', progress: { done: 0, total: 1512 } },
      {
        status: 'partial',
        briefs: briefs.slice(0, 40),
        progress: { done: 142, total: 1512 },
      },
    ]);
    panel(api);
    await screen.findByText('142 of 1,512 sections ready');
    expect(api.spy.breakdown.mock.calls.length).toBeGreaterThan(1);
  });

  test('a stopped run says so, keeps the briefs and stops asking', async () => {
    const { briefs } = syntheticBill();
    const api = scripted([
      {
        status: 'partial',
        briefs: briefs.slice(0, 40),
        progress: { done: 40, total: 1512, stoppedReason: 'budget_exhausted' },
      },
    ]);
    panel(api);
    await screen.findByText(/40 of 1,512 sections are ready/);
    const calls = api.spy.breakdown.mock.calls.length;
    await new Promise((r) => setTimeout(r, 40));
    expect(api.spy.breakdown.mock.calls.length).toBe(calls);
    expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
  });

  test('a long bill asks for pictures while briefs arrive; a short one waits for the end', async () => {
    const { briefs } = syntheticBill();
    const long = scripted([
      {
        status: 'partial',
        briefs: briefs.slice(0, 40),
        progress: { done: 40, total: 120 },
      },
    ]);
    panel(long);
    await waitFor(() => {
      expect(long.spy.pictures).toHaveBeenCalled();
    });
    cleanup();
    const short = scripted([
      {
        status: 'partial',
        briefs: briefs.slice(0, 5),
        progress: { done: 5, total: 20 },
      },
    ]);
    panel(short);
    await screen.findByText('5 of 20 sections ready');
    await new Promise((r) => setTimeout(r, 30));
    expect(short.spy.pictures).not.toHaveBeenCalled();
  });
});

describe('groups and filter for a long bill', () => {
  const cached = (): BreakdownResponse => ({
    status: 'cached',
    briefs: syntheticBill().briefs,
    omitted: 0,
  });

  test('120 sections form three collapsible groups, the first open', async () => {
    panel(scripted([cached()]));
    const toggles = await screen.findAllByRole('button', { name: /Title \d/ });
    expect(toggles).toHaveLength(3);
    expect(toggles.map((t) => t.getAttribute('aria-expanded'))).toEqual([
      'true',
      'false',
      'false',
    ]);
    // Group headings are real headings, and cards sit one level below them.
    expect(screen.getAllByRole('heading', { level: 4 })).toHaveLength(3);
    expect(screen.getAllByRole('article')).toHaveLength(40);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();

    fireEvent.click(toggles[1]!);
    expect(toggles[1]!.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getAllByRole('article')).toHaveLength(80);
    expect(toggles[1]!.getAttribute('aria-controls')).toBeTruthy();
    fireEvent.click(toggles[0]!);
    expect(screen.getAllByRole('article')).toHaveLength(40);
  });

  test('the filter narrows by heading or text, opens the groups with matches and counts them', async () => {
    panel(scripted([cached()]));
    const box = await screen.findByRole('searchbox', {
      name: /Find in these sections/,
    });
    fireEvent.change(box, { target: { value: 'bus garage' } });
    await screen.findByText('1 of 120 sections match.');
    const cards = screen.getAllByRole('article');
    expect(cards).toHaveLength(1);
    expect(within(cards[0]!).getByText(/funds a bus garage/)).toBeTruthy();

    fireEvent.change(box, { target: { value: 'rule 3' } });
    await screen.findByText(/sections match\./);
    fireEvent.change(box, { target: { value: 'zzz' } });
    await screen.findByText('No sections match.');
    fireEvent.change(box, { target: { value: '' } });
    expect(screen.getAllByRole('article')).toHaveLength(40);
  });

  test('a long bill with no containers is a filterable list with the first-six rule', async () => {
    const flat = syntheticBill()
      .outline.filter((o) => o.level === 2)
      .map((o) => ({ ...o, level: 1 }));
    panel(scripted([cached()]), flat);
    await screen.findByRole('button', { name: 'Show all 120 sections' });
    expect(screen.getAllByRole('article')).toHaveLength(6);
    expect(screen.getByRole('searchbox')).toBeTruthy();
  });

  test('a short bill keeps the first six and Show all, with no filter box or groups', async () => {
    const { briefs, outline } = syntheticBill();
    panel(
      scripted([{ status: 'cached', briefs: briefs.slice(0, 10), omitted: 0 }]),
      outline,
    );
    await screen.findByRole('button', { name: 'Show all 10 sections' });
    expect(screen.getAllByRole('article')).toHaveLength(6);
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /Title/ })).toBeNull();
  });
});
