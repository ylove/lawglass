import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { BRAND } from '../core/brand.js';
import { SAMPLE_PATH, visit } from '../../tests/support/web-routes.js';
import { App } from './App.js';
import type { ApiClient } from './api.js';
import { numberCitations, stripMarkers } from './AnswerText.js';
import { describeLocation } from './CitationDrawer.js';
import { validateUrl } from './Ingest.js';
import { createMockApi } from './mock-api.js';
import { ApiError } from './sse.js';

beforeEach(() => {
  // These suites exercise an open document; the homepage has its own tests.
  visit(SAMPLE_PATH);
});
afterEach(cleanup);

const mock = (publicMode = false): ApiClient =>
  createMockApi({ delayMs: 0, publicMode });

/** Waits for the sample document to load. */
async function ready() {
  await screen.findByRole('heading', {
    name: 'Clean Water Infrastructure Act',
  });
}

describe('helpers', () => {
  test('validateUrl gives plain-language problems', () => {
    expect(validateUrl('')).toMatch(/Enter/);
    expect(validateUrl('hello')).toMatch(/does not look like/);
    expect(validateUrl('ftp://x.org/a')).toMatch(/http/);
    expect(validateUrl(' https://x.org/a ')).toBeNull();
  });

  test('describeLocation covers pages, lines and section-only', () => {
    expect(
      describeLocation({ pageStart: 3, lineStart: 5, lineEnd: 12 }, true),
    ).toBe('Page 3, lines 5-12');
    expect(
      describeLocation({ pageStart: 3, pageEnd: 4, lineStart: 9 }, true),
    ).toBe('Pages 3-4, line 9');
    expect(describeLocation({}, true)).toMatch(/not available/);
    expect(describeLocation({ pageStart: 3 }, false)).toMatch(
      /Section-only citation/,
    );
  });

  test('stripMarkers hides whole and half-typed markers', () => {
    expect(stripMarkers('Yes [S:a/b] and')).toBe('Yes  and');
    expect(stripMarkers('Yes [S:a/')).toBe('Yes');
    expect(stripMarkers('Yes [')).toBe('Yes');
  });

  test('numberCitations numbers by first appearance and skips invalid ones', () => {
    const cites = [
      { sectionId: 'b', valid: true, chunkIds: [] },
      { sectionId: 'a', valid: true, chunkIds: [] },
      { sectionId: 'x', valid: false, chunkIds: [] },
    ];
    const n = numberCitations('[S:a] [S:b] [S:a] [S:x]', cites);
    expect([...n]).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
  });
});

describe('document flow', () => {
  test('history failures leave the document readable and show history unavailable', async () => {
    const api = mock();
    const real = api.getDoc.bind(api);
    api.getDoc = async (id) => ({
      ...(await real(id)),
      warnings: [
        'History unavailable: the official history could not be read or saved.',
      ],
    });
    render(<App api={api} />);
    await ready();
    expect(await screen.findByText(/History unavailable/)).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    ).toBeTruthy();
  });
  test('chip click streams an answer, then citations open the source drawer', async () => {
    render(<App api={mock()} />);
    await ready();
    const chip = screen.getByRole('button', { name: 'What does it change?' });
    fireEvent.click(chip);

    const cite = await screen.findAllByRole('button', { name: 'Source 1' });
    expect(cite.length).toBeGreaterThan(0);
    expect(screen.getByText(/shortens the deadline/)).toBeTruthy();
    // No raw markers leak into the final text.
    expect(screen.queryByText(/\[S:/)).toBeNull();

    fireEvent.click(cite[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Source text' });
    await within(dialog).findByText(/Lead pipe replacement/);
    expect(within(dialog).getByText(/Page 3, lines 5-12/)).toBeTruthy();
    expect(
      within(dialog).getByText(
        'Clean Water Infrastructure Act > Section 4 > (b)',
      ),
    ).toBeTruthy();
  });

  test('deleted and inserted spans are marked without relying on color', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'What does it change?' }),
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Source 1' }))[0]!,
    );
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText(/Lead pipe replacement/);

    const del = dialog.querySelector('.excerpt del');
    expect(del?.textContent).toBe('removed: within fifteen years');
    expect(del?.querySelector('.sr-only')?.textContent).toBe('removed: ');
    const ins = dialog.querySelector('.excerpt ins');
    expect(ins?.textContent).toBe('added: within ten years');
    // Child enumerators stay part of the span text.
    expect(dialog.textContent).toContain('(1) The utility shall notify');
  });

  test('the drawer takes focus, traps Tab, closes on Escape and returns focus', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Penalties and enforcement' }),
    );
    const cite = (
      await screen.findAllByRole('button', { name: 'Source 1' })
    )[0]!;
    cite.focus();
    fireEvent.click(cite);
    const dialog = await screen.findByRole('dialog');
    const close = within(dialog).getByRole('button', { name: 'Close' });
    expect(document.activeElement).toBe(close);

    // The close button is the only control: Tab wraps to itself in both directions.
    fireEvent.keyDown(dialog, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(close);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(document.activeElement).toBe(cite);
  });

  test('clicking the backdrop closes the drawer, clicking inside does not', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'When does it take effect?' }),
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Source 1' }))[0]!,
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(dialog);
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(dialog.parentElement!);
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  test('the sources list opens the same drawer and shows page and line', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Penalties and enforcement' }),
    );
    const sources = await screen.findByRole('heading', { name: 'Sources' });
    const list = sources.parentElement!;
    expect(within(list).getByText(/Page 4, lines 1-3/)).toBeTruthy();
    fireEvent.click(within(list).getByRole('button', { name: /Section 6/ }));
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  test('the drawer reports a section that cannot be loaded', async () => {
    const api = mock();
    api.getSection = () =>
      Promise.reject(new ApiError('X', 'That section is gone.'));
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Penalties and enforcement' }),
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Source 1' }))[0]!,
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'That section is gone.',
    );
  });

  test('XML documents say citations are section-only', async () => {
    const api = mock();
    render(<App api={api} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('Web address of the bill'), {
      target: { value: 'https://example.gov/bill.xml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read this bill' }));
    await screen.findByText(/no printed line numbers/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Penalties and enforcement' }),
    );
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Source 1' }))[0]!,
    );
    expect(await screen.findByText(/Section-only citation/)).toBeTruthy();
  });

  test('metadata hides null fields and the laws-it-refers-to panel lists refs', async () => {
    render(<App api={mock()} />);
    await ready();
    expect(screen.getAllByText('HB 214').length).toBeGreaterThan(0);
    // Sponsors are now profile links (see features.test.tsx for the labels and the cosponsor disclosure).
    expect(screen.getByRole('link', { name: /Rep. A. Rivera/ })).toBeTruthy();
    expect(screen.getByText('and 1 cosponsor')).toBeTruthy();
    const refs = screen.getByRole('region', { name: 'Laws it refers to' });
    expect(within(refs).getByText('42 U.S.C. 300g-1')).toBeTruthy();
    expect(within(refs).getByText(/mentioned in 2 sections/)).toBeTruthy();
    expect(within(refs).getByText(/mentioned in 1 section\b/)).toBeTruthy();
  });

  test('null metadata fields are not rendered as empty rows', async () => {
    const api = mock();
    const real = api.getDoc.bind(api);
    api.getDoc = async (id) => {
      const d = await real(id);
      return {
        ...d,
        externalRefs: [],
        metadata: {
          ...d.metadata,
          billNumber: null,
          jurisdiction: null,
          session: null,
          version: null,
          sponsors: [],
          source: 'extracted',
        },
      };
    };
    render(<App api={api} />);
    await ready();
    expect(screen.queryByText('Number')).toBeNull();
    expect(screen.queryByText('Sponsors')).toBeNull();
    expect(
      screen.queryByRole('region', { name: 'Laws it refers to' }),
    ).toBeNull();
    expect(
      screen.getByText(/picked out of the text automatically/),
    ).toBeTruthy();
  });

  test('answer warnings are shown in plain language', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Taxes, fees, and spending' }),
    );
    expect(
      await screen.findByText(/did not match the document and were removed/),
    ).toBeTruthy();
  });

  test('a declined answer shows the decline sentence without sources', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.change(screen.getByLabelText('Or ask your own question'), {
      target: { value: 'Tell me about the moon' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }));
    expect(
      await screen.findByText("This document doesn't address that question."),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Sources' })).toBeNull();
  });

  test('screen readers hear status lines, not every token', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Who does it affect?' }),
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('Searching the document...');
    await screen.findAllByRole('button', { name: 'Source 1' });
    await waitFor(() => {
      expect(status.textContent).toBe('Answer ready');
    });
    // The answer text itself is outside any live region.
    const cite = screen.getAllByRole('button', { name: 'Source 1' })[0]!;
    expect(cite.closest('[aria-live]')).toBeNull();
    expect(cite.closest('[role="status"]')).toBeNull();
  });

  test('a streaming answer announces "Writing the answer..."', async () => {
    const api = mock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    api.ask = async function* () {
      yield { type: 'token' as const, text: 'Partial answer ' };
      await gate;
    };
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Who does it affect?' }),
    );
    await screen.findByText('Partial answer');
    expect(screen.getByRole('status').textContent).toBe(
      'Writing the answer...',
    );
    release();
  });

  test('a busy chip stays focused and aria-disabled, and ignores clicks', async () => {
    const api = mock();
    const real = api.ask.bind(api);
    let calls = 0;
    api.ask = (...args) => {
      calls += 1;
      return real(...args);
    };
    render(<App api={api} />);
    await ready();
    const chip = screen.getByRole('button', { name: 'Who does it affect?' });
    chip.focus();
    fireEvent.click(chip);
    expect(chip.getAttribute('aria-disabled')).toBe('true');
    expect((chip as HTMLButtonElement).disabled).toBe(false);
    expect(document.activeElement).toBe(chip);
    fireEvent.click(chip);
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    );
    await screen.findAllByRole('button', { name: 'Source 1' });
    expect(calls).toBe(1);
    expect(document.activeElement).toBe(chip);
    expect(chip.getAttribute('aria-disabled')).toBe('false');
  });

  test('the delegations answer shows its groups as headings over lists', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Who decides later?' }));
    for (const heading of [
      'Decided later by',
      'Depends on',
      'Takes effect when',
    ])
      expect((await screen.findByText(heading)).tagName).toBe('STRONG');
    expect(screen.getAllByRole('list').length).toBeGreaterThanOrEqual(1);
    expect(
      (await screen.findAllByRole('button', { name: /^Source \d+$/ })).length,
    ).toBeGreaterThan(1);
  });

  test('a TRUNCATED warning is explained in plain language', async () => {
    const api = mock();
    const real = api.ask.bind(api);
    api.ask = async function* (...args) {
      for await (const e of real(...args)) {
        if (e.type === 'done') e.answer.warnings = ['TRUNCATED'];
        yield e;
      }
    };
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Who does it affect?' }),
    );
    expect(
      await screen.findByText(
        'This answer was cut short, so it may be incomplete.',
      ),
    ).toBeTruthy();
  });

  test('stream errors and cut-off streams are reported', async () => {
    const failing = mock();
    // eslint-disable-next-line @typescript-eslint/require-await
    failing.ask = async function* () {
      throw new ApiError('X', 'The model is down.');
    };
    const { unmount } = render(<App api={failing} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The model is down.',
    );
    unmount();

    const cutOff = mock();
    cutOff.ask = async function* () {
      yield await Promise.resolve({ type: 'token' as const, text: 'Partial ' });
    };
    render(<App api={cutOff} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    );
    expect((await screen.findByRole('alert')).textContent).toMatch(/cut off/);
  });

  test('a scenario event is ignored safely until the UI renders it (#131)', async () => {
    const api = mock();
    const real = api.ask.bind(api);
    api.ask = async function* (...args: Parameters<ApiClient['ask']>) {
      yield {
        type: 'scenario' as const,
        scenario: {
          subject: 'x',
          profile: {
            name: 'A',
            label: 'A renter',
            assumptions: [],
            illustrative: true as const,
          },
          frames: ['setup', 'rule', 'effect'].map((kind) => ({
            kind: kind as 'setup',
            avatar: 'person-a' as const,
            icon: 'house' as const,
            caption: 'c',
            citations: [],
          })),
        },
      };
      yield* real(...args);
    };
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    );
    expect(await screen.findByText(/lead pipes/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('an error event from the server is shown and chips work again', async () => {
    const api = mock(true);
    const [doc] = await api.listDocs();
    expect(doc).toBeTruthy();
    const real = api.ask.bind(api);
    // eslint-disable-next-line @typescript-eslint/require-await
    api.ask = async function* () {
      yield {
        type: 'error' as const,
        error: { code: 'RATE_LIMITED', message: 'Please wait a moment.' },
      };
    };
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    );
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Please wait a moment.',
    );
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Summarize this bill',
      }).disabled,
    ).toBe(false);
    api.ask = real;
  });

  test('chips are real buttons that work from the keyboard (Enter/Space click)', async () => {
    render(<App api={mock()} />);
    await ready();
    const chips = within(
      screen.getByRole('group', { name: 'What would you like to know?' }),
    ).getAllByRole('button');
    expect(chips).toHaveLength(10);
    for (const c of chips) expect(c.tagName).toBe('BUTTON');
  });

  test('a document that fails to load shows an alert', async () => {
    const api = mock();
    api.getDoc = () => Promise.reject(new ApiError('X', 'Could not open it.'));
    render(<App api={api} />);
    expect(
      (await screen.findByText('Could not open it.')).getAttribute('role'),
    ).toBe('alert');
  });
});

describe('public mode', () => {
  test('the freeform box is hidden when freeform is off', async () => {
    render(<App api={mock(true)} />);
    await ready();
    expect(screen.queryByLabelText('Or ask your own question')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Summarize this bill' }),
    ).toBeTruthy();
  });

  test('the freeform box is visible in normal mode and ignores blank questions', async () => {
    render(<App api={mock()} />);
    await ready();
    const ask = screen.getByRole<HTMLButtonElement>('button', { name: 'Ask' });
    expect(ask.getAttribute('aria-disabled')).toBe('true');
    fireEvent.submit(ask.closest('form')!);
    expect(screen.getByText(/Choose a question above/)).toBeTruthy();
  });

  test('publicMode hides freeform even if the server says it is enabled', async () => {
    const api = mock();
    api.getConfig = async () => ({
      ...(await mock().getConfig()),
      publicMode: true,
      freeformEnabled: true,
    });
    render(<App api={api} />);
    await ready();
    expect(screen.queryByLabelText('Or ask your own question')).toBeNull();
  });
});

describe('ingest flow', () => {
  async function startIngest(api: ApiClient) {
    render(<App api={api} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
  }
  const input = () => screen.getByLabelText('Web address of the bill');
  const submit = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Read this bill' }));

  test('validates the address before sending anything', async () => {
    await startIngest(mock());
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /Enter the web address/,
    );
    expect(input().getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(input(), { target: { value: 'not a url' } });
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /does not look like/,
    );
  });

  test('streams progress to done, then opens the new document and lists it', async () => {
    await startIngest(mock());
    expect(screen.getByText(/Demo mode/)).toBeTruthy();
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/new.pdf' },
    });
    submit();
    await screen
      .findByRole('button', { name: 'Chips' }, { timeout: 50 })
      .catch(() => undefined);
    // Lands on the document view; the sidebar now lists both documents.
    await screen.findByRole('group', { name: 'What would you like to know?' });
    const nav = screen.getByRole('navigation', { name: 'Loaded documents' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/already loaded/)).toBeNull();
  });

  test('shows each stage as the stream advances', async () => {
    const api = mock();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    api.ingest = async function* () {
      yield { type: 'progress' as const, stage: 'parsing' as const };
      yield {
        type: 'progress' as const,
        stage: 'embedding' as const,
        done: 20,
        total: 40,
      };
      await gate;
      yield {
        type: 'error' as const,
        error: {
          code: 'PARSE_FAILED',
          message: 'The document could not be read.',
        },
      };
    };
    await startIngest(api);
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/p.pdf' },
    });
    submit();
    const current = await screen.findByText(/20 of 40/);
    const item = current.closest('li')!;
    expect(item.getAttribute('aria-current')).toBe('step');
    expect(item.textContent).toContain('(in progress)');
    const items = screen
      .getAllByRole('listitem')
      .filter((li) => li.dataset.state);
    expect(items.map((li) => li.dataset.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
      'current',
      'todo',
    ]);
    release();
    expect(
      (await screen.findByText('The document could not be read.')).getAttribute(
        'role',
      ),
    ).toBe('alert');
  });

  test('a wrapper page offers candidates; picking one re-submits that address', async () => {
    await startIngest(mock());
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/wrapper' },
    });
    submit();
    await screen.findByRole('heading', { name: 'Choose the file to read' });
    fireEvent.click(screen.getByRole('button', { name: /Bill text \(XML\)/ }));
    await screen.findByRole('group', { name: 'What would you like to know?' });
    const nav = screen.getByRole('navigation', { name: 'Loaded documents' });
    expect(within(nav).getAllByRole('listitem')).toHaveLength(2);
  });

  test('errors show the server message', async () => {
    await startIngest(mock());
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/fail' },
    });
    submit();
    expect(
      (
        await screen.findByText('The document could not be downloaded.')
      ).getAttribute('role'),
    ).toBe('alert');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Read this bill' })
        .disabled,
    ).toBe(false);
  });

  test('a stream that ends early, or throws, shows a message', async () => {
    const early = mock();
    // eslint-disable-next-line @typescript-eslint/require-await
    early.ingest = async function* () {
      yield { type: 'progress' as const, stage: 'fetching' as const };
    };
    const { unmount } = render(<App api={early} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/e.pdf' },
    });
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(
      /ended before/,
    );
    unmount();

    const broken = mock();
    // eslint-disable-next-line @typescript-eslint/require-await
    broken.ingest = async function* () {
      throw new Error('internal detail');
    };
    visit(SAMPLE_PATH);
    await startIngest(broken);
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/e.pdf' },
    });
    submit();
    // Internal error text is never shown to readers.
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Something went wrong. Please try again.',
    );
  });

  test('re-ingesting a loaded address tells the reader nothing new was processed', async () => {
    await startIngest(mock());
    fireEvent.change(input(), {
      target: { value: 'https://example.gov/bills/hb214.pdf' },
    });
    submit();
    expect(await screen.findByText(/already loaded/)).toBeTruthy();
  });
});

describe('sidebar and shell', () => {
  test('the document list is a collapsible disclosure for narrow screens', async () => {
    render(<App api={mock()} />);
    await ready();
    const toggle = screen.getByRole('button', { name: 'Your documents (1)' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    const panel = document.getElementById(
      toggle.getAttribute('aria-controls')!,
    )!;
    expect(panel.classList.contains('open')).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(panel.classList.contains('open')).toBe(true);
    fireEvent.click(within(panel).getByRole('button', { name: 'Add a bill' }));
    // The homepage has no sidebar; the list is in the main column.
    await screen.findByRole('heading', { name: 'Add a bill' });
    expect(
      screen.queryByRole('button', { name: /^Your documents/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('link', { name: /Clean Water Infrastructure Act/ }),
    );
    await ready();
    const again = screen.getByRole('button', { name: 'Your documents (1)' });
    fireEvent.click(again);
    fireEvent.click(
      screen.getByRole('button', {
        name: /^Clean Water Infrastructure Act\s+HB 214$/,
      }),
    );
    expect(again.getAttribute('aria-expanded')).toBe('false');
  });

  test('remove asks first; keeping it changes nothing; confirming removes and shows ingest', async () => {
    render(<App api={mock()} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove Clean Water Infrastructure Act',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(
      screen.getByRole('heading', { name: 'Clean Water Infrastructure Act' }),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove Clean Water Infrastructure Act',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await screen.findByRole('heading', { name: 'Add a bill' });
    expect(screen.getByText(/Nothing here yet/)).toBeTruthy();
  });

  test('a failed removal is reported and the document stays', async () => {
    const api = mock();
    api.removeDoc = () =>
      Promise.reject(new ApiError('X', 'Could not remove it.'));
    render(<App api={api} />);
    await ready();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Remove Clean Water Infrastructure Act',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    expect(
      (await screen.findByText('Could not remove it.')).getAttribute('role'),
    ).toBe('alert');
    expect(
      screen.getByRole('heading', { name: 'Clean Water Infrastructure Act' }),
    ).toBeTruthy();
  });

  test('the footer names the provider that receives bill text and questions', async () => {
    const api = mock();
    api.getConfig = async () => ({
      ...(await mock().getConfig()),
      provider: 'anthropic',
    });
    render(<App api={api} />);
    await ready();
    expect(screen.getByRole('contentinfo').textContent).toContain(
      'Bill text and your questions are sent to Anthropic to write answers.',
    );
  });

  test('has landmarks, a skip link, the config product name and the footer', async () => {
    const api = mock();
    api.getConfig = async () => ({
      ...(await mock().getConfig()),
      productName: 'Civic Reader',
    });
    render(<App api={api} />);
    await ready();
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    const footer = screen.getByRole('contentinfo');
    expect(footer.textContent).toContain(
      'Not legal advice. Answers are generated only from the text of this document.',
    );
    // The mock provider sends nothing anywhere, so no data note is shown.
    expect(footer.textContent).not.toContain('are sent to');
    const repo = within(footer).getByRole('link', { name: 'Source code' });
    expect(repo.getAttribute('href')).toBe(BRAND.repositoryUrl);
    expect(repo.getAttribute('rel')).toBe('noopener noreferrer');
    expect(
      screen
        .getByRole('link', { name: 'Skip to main content' })
        .getAttribute('href'),
    ).toBe('#main');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Civic Reader',
    );
    await waitFor(() => {
      expect(document.title).toBe('Civic Reader');
    });
  });

  test('a server-side failure is shown as a plain alert', async () => {
    const api = mock();
    api.getConfig = () =>
      Promise.reject(
        new ApiError('HTTP_ERROR', 'The server reported a problem.'),
      );
    render(<App api={api} />);
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The server reported a problem.',
    );
  });

  test('selecting another document switches the view', async () => {
    const api = mock();
    render(<App api={api} />);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    fireEvent.change(screen.getByLabelText('Web address of the bill'), {
      target: { value: 'https://example.gov/two.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read this bill' }));
    await screen.findByRole('group', { name: 'What would you like to know?' });
    const nav = screen.getByRole('navigation', { name: 'Loaded documents' });
    const links = within(nav)
      .getAllByRole('button', { name: /two.pdf|Clean Water/ })
      .filter((b) => b.className === 'doc-link');
    expect(links).toHaveLength(2);
    fireEvent.click(links[1]!);
    await waitFor(() => {
      expect(links[1]!.getAttribute('aria-current')).toBe('page');
    });
  });
});

describe('local measure demo document', () => {
  test('a charter address ingests as a scanned charter amendment', async () => {
    const api = mock();
    let docId = '';
    for await (const e of api.ingest({
      url: 'https://example.gov/charter.pdf',
    }))
      if (e.type === 'done') docId = e.doc.docId;
    const detail = await api.getDoc(docId);
    expect(detail.metadata.docKind).toBe('charter_amendment');
    expect(detail.metadata.amends?.sections).toContain('41-5');
    expect(detail.scan?.pages.some((p) => p.marks === 'not-read')).toBe(true);
  });
});
