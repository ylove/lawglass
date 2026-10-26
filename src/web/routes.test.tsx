import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { SAMPLE_PATH, visit } from '../../tests/support/web-routes.js';
import { BRAND } from '../core/brand.js';
import { App } from './App.js';
import type { ApiClient } from './api.js';
import { createMockApi } from './mock-api.js';
import { formatRelativeDate } from './format-date.js';
import { docPath, parseDocPath } from './nav.js';

afterEach(cleanup);

const mock = (): ApiClient => createMockApi({ delayMs: 0 });
const SAMPLE = 'Clean Water Infrastructure Act';

/** Replace parts of the mock's config, e.g. to act like a hosted server. */
function withConfig(
  api: ApiClient,
  patch: Partial<Awaited<ReturnType<ApiClient['getConfig']>>>,
): ApiClient {
  const real = api.getConfig.bind(api);
  api.getConfig = async () => ({ ...(await real()), ...patch });
  return api;
}

describe('path helpers', () => {
  test('docPath and parseDocPath round-trip and reject other shapes', () => {
    expect(parseDocPath(docPath('abc'))).toBe('abc');
    expect(parseDocPath('/doc/abc/')).toBe('abc');
    for (const path of ['/', '/doc', '/doc/', '/doc/a/b', '/x/abc', '/doc/%E0'])
      expect(parseDocPath(path)).toBeNull();
  });
});

describe('homepage', () => {
  test('a visitor lands on the homepage and no document auto-opens', async () => {
    render(<App api={mock()} />);
    await screen.findByText('Understand any bill, line by line.');
    expect(window.location.pathname).toBe('/');
    expect(screen.getByLabelText('Web address of the bill')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: SAMPLE })).toBeNull();
    // The list is in the main column, with no sidebar.
    expect(
      screen.queryByRole('navigation', { name: 'Loaded documents' }),
    ).toBeNull();
    const list = screen.getByRole('region', { name: 'Your documents' });
    const link = within(list).getByRole('link', { name: /Clean Water/ });
    expect(link.getAttribute('href')).toBe(docPath('a'.repeat(64)));
    expect(link.textContent).toContain('HB 214');
    expect(link.textContent).toMatch(/ago|today|yesterday|20\d\d/);
  });

  test('says so when the list is empty', async () => {
    const api = mock();
    api.listDocs = () => Promise.resolve([]);
    render(<App api={api} />);
    expect(await screen.findByText(/Nothing here yet/)).toBeTruthy();
  });

  test('opening a document pushes /doc/<id>; back and forward follow', async () => {
    render(<App api={mock()} />);
    fireEvent.click(await screen.findByRole('link', { name: /Clean Water/ }));
    await screen.findByRole('heading', { name: SAMPLE });
    expect(window.location.pathname).toBe(SAMPLE_PATH);
    expect(
      screen.getByRole('navigation', { name: 'Loaded documents' }),
    ).toBeTruthy();

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/');
    });
    await screen.findByText('Understand any bill, line by line.');

    act(() => {
      window.history.forward();
    });
    await screen.findByRole('heading', { name: SAMPLE });
  });

  test('the logo is a link home', async () => {
    visit(SAMPLE_PATH);
    render(<App api={mock()} />);
    await screen.findByRole('heading', { name: SAMPLE });
    const logo = screen.getByRole('link', {
      name: `${BRAND.displayName} home`,
    });
    expect(logo.getAttribute('href')).toBe('/');
    expect(logo.querySelector('svg')).not.toBeNull();
    // Modified clicks are left to the browser (open in a new tab).
    expect(fireEvent.click(logo, { ctrlKey: true })).toBe(true);
    fireEvent.click(logo);
    await screen.findByText('Understand any bill, line by line.');
    expect(window.location.pathname).toBe('/');
  });

  test('"Add a bill" in the sidebar goes home', async () => {
    visit(SAMPLE_PATH);
    render(<App api={mock()} />);
    await screen.findByRole('heading', { name: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: 'Add a bill' }));
    await screen.findByText('Understand any bill, line by line.');
    expect(window.location.pathname).toBe('/');
  });

  test('a reload on /doc/<id> opens that document', async () => {
    visit(SAMPLE_PATH);
    render(<App api={mock()} />);
    expect(await screen.findByRole('heading', { name: SAMPLE })).toBeTruthy();
    expect(screen.queryByText('Understand any bill, line by line.')).toBeNull();
  });

  test('an unknown id says so and links home', async () => {
    visit(docPath('b'.repeat(64)));
    render(<App api={mock()} />);
    expect(
      await screen.findByRole('heading', {
        name: "This document isn't in your list",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Go to the home page' }));
    await screen.findByText('Understand any bill, line by line.');
    expect(window.location.pathname).toBe('/');
  });

  test('a removed document sends the reader home', async () => {
    visit(SAMPLE_PATH);
    render(<App api={mock()} />);
    await screen.findByRole('heading', { name: SAMPLE });
    fireEvent.click(screen.getByRole('button', { name: `Remove ${SAMPLE}` }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, remove' }));
    await screen.findByText(/Nothing here yet/);
    expect(window.location.pathname).toBe('/');
  });

  test('a finished ingest opens the new document at its own address', async () => {
    render(<App api={mock()} />);
    fireEvent.change(await screen.findByLabelText('Web address of the bill'), {
      target: { value: 'https://example.gov/bills/new.pdf' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read this bill' }));
    await screen.findByRole('heading', { name: /Clean Water/ });
    expect(window.location.pathname).toMatch(/^\/doc\/[a-f0-9]{64}$/);
  });

  test('in-app navigation keeps the query string (?mock=1)', async () => {
    window.history.replaceState({}, '', '/?mock=1');
    render(<App api={mock()} />);
    const link = await screen.findByRole('link', { name: /Clean Water/ });
    expect(link.getAttribute('href')).toBe(`${docPath('a'.repeat(64))}?mock=1`);
    fireEvent.click(link);
    await screen.findByRole('heading', { name: SAMPLE });
    expect(window.location.search).toBe('?mock=1');
  });
});

describe('focus after navigation', () => {
  test('opening a document, the logo and back/forward all move focus to main', async () => {
    render(<App api={mock()} />);
    const open = await screen.findByRole('link', { name: /Clean Water/ });
    open.focus();
    fireEvent.click(open);
    await screen.findByRole('heading', { name: SAMPLE });
    expect(document.activeElement).toBe(screen.getByRole('main'));

    fireEvent.click(
      screen.getByRole('link', { name: `${BRAND.displayName} home` }),
    );
    await screen.findByText('Understand any bill, line by line.');
    expect(document.activeElement).toBe(screen.getByRole('main'));

    (document.activeElement as HTMLElement).blur();
    act(() => {
      window.history.back();
    });
    await screen.findByRole('heading', { name: SAMPLE });
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });

  test('the first page load does not steal focus', async () => {
    render(<App api={mock()} />);
    await screen.findByText('Understand any bill, line by line.');
    expect(document.activeElement).toBe(document.body);
  });
});

describe('examples', () => {
  test('clicking an example starts reading that address', async () => {
    render(<App api={mock()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'A second sample bill' }),
    );
    expect(
      screen.getByLabelText<HTMLInputElement>('Web address of the bill').value,
    ).toBe('https://example.gov/bills/sb77.pdf');
    await screen.findByRole('heading', { name: /Clean Water/ });
    expect(window.location.pathname).toMatch(/^\/doc\//);
  });

  test('the line is hidden when there are no examples', async () => {
    const api = withConfig(mock(), {});
    const real = api.getConfig.bind(api);
    api.getConfig = async () => {
      const { examples: _examples, ...rest } = await real();
      return rest;
    };
    render(<App api={api} />);
    await screen.findByText('Understand any bill, line by line.');
    expect(screen.queryByText(/Try an example/)).toBeNull();
  });
});

describe('reader library wording', () => {
  test('hosted servers say "Remove from my list" and that it stays for others', async () => {
    visit(SAMPLE_PATH);
    render(<App api={withConfig(mock(), { library: 'reader' })} />);
    await screen.findByRole('heading', { name: SAMPLE });
    const remove = screen.getByRole('button', {
      name: `Remove ${SAMPLE} from my list`,
    });
    expect(remove.textContent).toBe('Remove from my list');
    fireEvent.click(remove);
    expect(screen.getByText(/stays available to others/)).toBeTruthy();
  });

  test('local mode keeps plain "Remove"', async () => {
    visit(SAMPLE_PATH);
    render(<App api={withConfig(mock(), { library: 'local' })} />);
    await screen.findByRole('heading', { name: SAMPLE });
    expect(
      screen.getByRole('button', { name: `Remove ${SAMPLE}` }).textContent,
    ).toBe('Remove');
  });

  test('opening a document refreshes the reader list', async () => {
    visit(SAMPLE_PATH);
    const api = withConfig(mock(), { library: 'reader' });
    let lists = 0;
    const real = api.listDocs.bind(api);
    api.listDocs = () => {
      lists++;
      return real();
    };
    render(<App api={api} />);
    await screen.findByRole('heading', { name: SAMPLE });
    await waitFor(() => {
      expect(lists).toBe(2);
    });
  });
});

describe('formatRelativeDate', () => {
  const now = Date.parse('2026-10-20T12:00:00Z');
  test('says today, yesterday and days ago, then a date', () => {
    expect(formatRelativeDate('2026-10-20T01:00:00Z', now)).toBe('today');
    expect(formatRelativeDate('2026-10-19T01:00:00Z', now)).toBe('yesterday');
    expect(formatRelativeDate('2026-10-17T01:00:00Z', now)).toBe('3 days ago');
    expect(formatRelativeDate('2026-10-01T01:00:00Z', now)).toBe('Oct 1, 2026');
    expect(formatRelativeDate('soon', now)).toBe('soon');
  });
});
