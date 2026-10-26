import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  BreakdownResponse,
  ScenarioResponse,
  SectionBrief,
} from '../../core/model/index.js';
import { NO_EXAMPLE_NOTE } from '../../core/breakdown/notes.js';
import type { ApiClient } from '../api.js';
import { createMockApi } from '../mock-api.js';
import { ApiError } from '../sse.js';
import { BreakdownPanel, INITIAL_VISIBLE_BRIEFS } from './BreakdownPanel.js';

afterEach(cleanup);

const DOC = 'a'.repeat(64);

function brief(id: string, over: Partial<SectionBrief> = {}): SectionBrief {
  return {
    sectionId: id,
    num: id.replace('sec-', ''),
    heading: `Topic ${id}`,
    text: `This part does ${id}. [S:${id}]`,
    citations: [{ sectionId: id, valid: true, chunkIds: [] }],
    readingGrade: 5,
    example: 'available',
    ...over,
  };
}

/** A mock whose breakdown and example answers the test scripts. */
function scripted(
  breakdowns: (BreakdownResponse | Error)[],
  examples: (ScenarioResponse | Error)[] = [],
) {
  const api = createMockApi({ delayMs: 0 });
  const getBreakdown = vi.fn<ApiClient['getBreakdown']>(() => {
    const next = breakdowns.length > 1 ? breakdowns.shift() : breakdowns[0];
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next ?? { status: 'disabled' as const });
  });
  const getSectionExample = vi.fn<ApiClient['getSectionExample']>(() => {
    const next = examples.length > 1 ? examples.shift() : examples[0];
    return next instanceof Error
      ? Promise.reject(next)
      : Promise.resolve(next ?? { status: 'disabled' as const });
  });
  api.getBreakdown = getBreakdown;
  api.getSectionExample = getSectionExample;
  return Object.assign(api, {
    spy: { breakdown: getBreakdown, example: getSectionExample },
  });
}

const panel = (
  api: ApiClient,
  extra: Partial<Parameters<typeof BreakdownPanel>[0]> = {},
) =>
  render(
    <BreakdownPanel
      api={api}
      docId={DOC}
      enabled
      onOpenSection={() => undefined}
      pollMs={5}
      maxWaitMs={60}
      examplePollMs={5}
      exampleMaxWaitMs={5000}
      coolDownMs={5}
      {...extra}
    />,
  );

describe('BreakdownPanel states', () => {
  test('loading: a heading, the message and a skeleton, never an empty box', () => {
    const api = scripted([{ status: 'pending' }]);
    const { container } = panel(api);
    expect(
      screen.getByRole('heading', { name: 'Section by section' }),
    ).toBeTruthy();
    expect(screen.getByText('Reading each section…')).toBeTruthy();
    expect(
      container.querySelector('.brief-skeleton')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('partial: finished parts show while the rest is still being read', async () => {
    const api = scripted([
      { status: 'pending', briefs: [brief('sec-2')] },
      { status: 'pending', briefs: [brief('sec-2')] },
    ]);
    panel(api, { maxWaitMs: 10_000 });
    await screen.findByText(/This part does sec-2/);
    expect(screen.getByText('Reading the rest of the sections…')).toBeTruthy();
    expect(
      screen.getByRole('heading', { level: 4, name: /Section 2/ }),
    ).toBeTruthy();
  });

  test('done: cards with the brief, a numbered citation that opens the drawer, and no more reading note', async () => {
    const open = vi.fn();
    const api = scripted([
      {
        status: 'cached',
        briefs: [brief('sec-2'), brief('sec-3')],
        omitted: 0,
      },
    ]);
    panel(api, { onOpenSection: open });
    await screen.findByText(/This part does sec-2/);
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByText(/Reading/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Section 2 source 1' }));
    expect(open).toHaveBeenCalledWith('sec-2', expect.any(HTMLElement));
    // Polling stopped.
    const calls = api.spy.breakdown.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.spy.breakdown.mock.calls.length).toBe(calls);
  });

  test('omitted parts of a long bill are reported, and long lists fold behind a button', async () => {
    const many = Array.from({ length: INITIAL_VISIBLE_BRIEFS + 3 }, (_, i) =>
      brief(`sec-${String(i + 1)}`),
    );
    const api = scripted([{ status: 'cached', briefs: many, omitted: 4 }]);
    panel(api);
    await screen.findByText(/This part does sec-1\./);
    expect(screen.getAllByRole('article')).toHaveLength(INITIAL_VISIBLE_BRIEFS);
    expect(
      screen.getByText(/9 parts are shown; 4 more are not included/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', {
        name: `Show all ${String(many.length)} sections`,
      }),
    );
    expect(screen.getAllByRole('article')).toHaveLength(many.length);
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  test('a single omitted part reads in the singular', async () => {
    const api = scripted([
      { status: 'cached', briefs: [brief('sec-2')], omitted: 1 },
    ]);
    panel(api);
    await screen.findByText(/1 part is shown; 1 more is not included/);
  });

  test('disabled, and enabled=false, render nothing and ask nothing', async () => {
    const off = scripted([{ status: 'disabled' }]);
    const { container, unmount } = panel(off);
    await waitFor(() => {
      expect(off.spy.breakdown).toHaveBeenCalled();
      expect(container.querySelector('section')).toBeNull();
    });
    unmount();
    const never = scripted([{ status: 'cached', briefs: [brief('sec-2')] }]);
    const second = panel(never, { enabled: false });
    expect(second.container.innerHTML).toBe('');
    expect(never.spy.breakdown).not.toHaveBeenCalled();
  });

  test('a cached reply with no parts is treated as nothing to show', async () => {
    const api = scripted([{ status: 'cached', briefs: [] }]);
    const { container } = panel(api);
    await waitFor(() => {
      expect(container.querySelector('section')).toBeNull();
    });
  });

  test('error: says so after the last try, then retry starts over', async () => {
    const api = scripted([new ApiError('X', 'Nope.')]);
    panel(api);
    await screen.findByText(/could not be loaded right now/);
    expect(screen.queryByText(/Nope/)).toBeNull();
    api.spy.breakdown.mockResolvedValue({
      status: 'cached',
      briefs: [brief('sec-2')],
      omitted: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(/This part does sec-2/);
  });

  test('a failed call mid-way is retried quietly while time remains', async () => {
    const api = scripted([
      new ApiError('X', 'blip'),
      { status: 'cached', briefs: [brief('sec-2')] },
    ]);
    panel(api, { maxWaitMs: 10_000 });
    await screen.findByText(/This part does sec-2/);
    expect(screen.queryByText(/could not be loaded/)).toBeNull();
  });

  test('timeout: still pending after the maximum wait offers a retry', async () => {
    const api = scripted([{ status: 'pending' }]);
    panel(api);
    await screen.findByText(/taking longer than expected/);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });
});

describe('failures and slow runs', () => {
  test('a retry that restarts with fewer parts never takes shown cards away', async () => {
    const api = scripted([
      { status: 'pending', briefs: [brief('sec-2'), brief('sec-3')] },
      new ApiError('PROVIDER_ERROR', 'Try again in a minute.'),
    ]);
    panel(api, { maxWaitMs: 10_000 });
    await screen.findByText(/did not finish/);
    api.spy.breakdown.mockResolvedValue({ status: 'pending', briefs: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => {
      expect(api.spy.breakdown.mock.calls.length).toBeGreaterThan(2);
    });
    expect(screen.getByText(/This part does sec-2/)).toBeTruthy();
    expect(screen.getByText(/This part does sec-3/)).toBeTruthy();
  });

  test('a failed run keeps the parts already shown and offers a retry', async () => {
    const api = scripted([
      { status: 'pending', briefs: [brief('sec-2')] },
      new ApiError('PROVIDER_ERROR', 'Try again in a minute.'),
    ]);
    panel(api, { maxWaitMs: 10_000 });
    await screen.findByText(/Reading the rest of the sections did not finish/);
    expect(screen.getByText(/This part does sec-2/)).toBeTruthy();
    api.spy.breakdown.mockResolvedValue({
      status: 'cached',
      briefs: [brief('sec-2'), brief('sec-3')],
      omitted: 0,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByText(/This part does sec-3/);
    expect(screen.getByText(/This part does sec-2/)).toBeTruthy();
  });

  test('a failed run waits out the cool-down once, then looks again on its own (#341)', async () => {
    const api = scripted([
      new ApiError('PROVIDER_ERROR', 'Try again in a minute.'),
      { status: 'cached', briefs: [brief('sec-2')], omitted: 0 },
    ]);
    panel(api, { coolDownMs: 200 });
    await screen.findByText(/Trying again in about a minute/);
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    await screen.findByText(/This part does sec-2/);
    expect(screen.queryByText(/Trying again/)).toBeNull();
    expect(api.spy.breakdown).toHaveBeenCalledTimes(2);
  });

  test('a second failure after the cool-down asks the reader', async () => {
    const api = scripted([
      new ApiError('PROVIDER_ERROR', 'Try again in a minute.'),
    ]);
    panel(api);
    await screen.findByText(/could not be loaded right now/);
    expect(api.spy.breakdown).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  test('a run that keeps finishing parts is not timed out, however long it takes in all', async () => {
    const grow = Array.from({ length: 24 }, (_, i) => ({
      status: 'pending' as const,
      briefs: Array.from({ length: i + 1 }, (_, j) =>
        brief(`sec-${String(j + 1)}`),
      ),
    }));
    const api = scripted([
      ...grow,
      {
        status: 'cached',
        briefs: grow[23]!.briefs,
        omitted: 0,
      },
    ]);
    // 24 polls at 5 ms is longer than the 60 ms wait, but each poll brings a new part.
    panel(api, { pollMs: 5, maxWaitMs: 60, examplePollMs: 5 });
    await waitFor(
      () => {
        expect(screen.queryByText(/Reading the rest/)).toBeNull();
        expect(screen.getAllByRole('article').length).toBeGreaterThan(0);
      },
      { timeout: 3000 },
    );
    expect(screen.queryByText(/taking longer than expected/)).toBeNull();
  });
});

describe('the example control', () => {
  test('a failed example says so and offers a retry, never "not available"', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [
        new ApiError(
          'PROVIDER_ERROR',
          "Couldn't draw an example right now. Try again.",
        ),
      ],
    );
    panel(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByText("Couldn't draw an example right now. Try again.");
    expect(screen.queryByText(/not available on this server/)).toBeNull();
    expect(
      screen.getByRole('button', { name: /Try the example again/ }),
    ).toBeTruthy();
  });

  test('a failed example waits out the cool-down once before asking (#341)', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [
        new ApiError('PROVIDER_ERROR', 'x'),
        { status: 'none', note: 'Nothing to draw here.' },
      ],
    );
    panel(api, { coolDownMs: 200 });
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByText(/Trying again in about a minute/);
    await screen.findByText('Nothing to draw here.');
    expect(api.spy.example).toHaveBeenCalledTimes(2);
  });

  test('button, then a visible loader, then the strip with its footnotes', async () => {
    const mock = createMockApi({ delayMs: 0 });
    panel(mock, { maxWaitMs: 5000 });
    const button = await screen.findByRole('button', {
      name: /Show an example for Section 4\(b\)/,
    });
    fireEvent.click(button);
    await screen.findByText('Drawing an example…');
    const strip = await screen.findByRole('region', {
      name: /What it could mean for Sam/,
    });
    expect(strip.className).toContain('scenario-nested');
    expect(screen.queryByText('Drawing an example…')).toBeNull();
    // The footnote opens the same drawer as any citation.
    expect(
      screen.getAllByRole('button', { name: /Example source 1/ }).length,
    ).toBeGreaterThan(0);
    // The control now hides and shows the example.
    fireEvent.click(screen.getByRole('button', { name: /Hide example/ }));
    expect(
      screen.queryByRole('region', { name: /What it could mean/ }),
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Show example/ }));
    expect(
      screen.getByRole('region', { name: /What it could mean/ }),
    ).toBeTruthy();
  });

  test('a part with no example shows our one-line note instead of a button', async () => {
    const mock = createMockApi({ delayMs: 0 });
    panel(mock, { maxWaitMs: 5000 });
    await screen.findByText(/annual report/);
    const note = screen.getByText(NO_EXAMPLE_NOTE);
    expect(
      note.closest('article')?.querySelector('button.brief-example-btn'),
    ).toBeNull();
  });

  test('two examples on one page get distinct headings', async () => {
    const mock = createMockApi({ delayMs: 0 });
    panel(mock, { maxWaitMs: 5000 });
    for (const section of ['4\\(b\\)', '6'])
      fireEvent.click(
        await screen.findByRole('button', {
          name: new RegExp(`Show an example for Section ${section}`),
        }),
      );
    await waitFor(() => {
      expect(
        screen.getAllByRole('region', { name: /What it could mean/ }),
      ).toHaveLength(2);
    });
    const ids = screen
      .getAllByRole('region', { name: /What it could mean/ })
      .map((r) => r.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
  });

  test('none from the server shows its note and no strip', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [
        { status: 'pending' },
        { status: 'none', note: 'We could not draw one.' },
      ],
    );
    panel(api, { maxWaitMs: 5000 });
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByText('We could not draw one.');
    expect(
      screen.queryByRole('button', { name: /Show an example/ }),
    ).toBeNull();
    expect(api.spy.example).toHaveBeenCalledWith(
      DOC,
      'sec-2',
      expect.anything(),
    );
  });

  test('disabled on this server says so', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [{ status: 'disabled' }],
    );
    panel(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByText(/not available on this server/);
  });

  test('an error offers to try again, and the retry can succeed', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [new ApiError('X', 'The example failed.')],
    );
    panel(api);
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByRole('alert');
    expect(screen.getByText('The example failed.')).toBeTruthy();
    api.spy.example.mockResolvedValue({
      status: 'none',
      note: 'No example here.',
    });
    fireEvent.click(
      screen.getByRole('button', { name: /Try the example again/ }),
    );
    await screen.findByText('No example here.');
  });

  test('an example still pending after the maximum wait becomes a retryable error', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [{ status: 'pending' }],
    );
    panel(api, { exampleMaxWaitMs: 40 });
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await screen.findByText(/taking longer than expected/);
    expect(
      screen.getByRole('button', { name: /Try the example again/ }),
    ).toBeTruthy();
  });

  test('leaving the page stops polling', async () => {
    const api = scripted(
      [{ status: 'cached', briefs: [brief('sec-2')] }],
      [{ status: 'pending' }],
    );
    const { unmount } = panel(api, { maxWaitMs: 5000 });
    fireEvent.click(
      await screen.findByRole('button', { name: /Show an example/ }),
    );
    await waitFor(() => {
      expect(api.spy.example).toHaveBeenCalled();
    });
    unmount();
    const calls = api.spy.example.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(api.spy.example.mock.calls.length).toBe(calls);
  });
});
