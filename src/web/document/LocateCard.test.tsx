import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createMockApi } from '../mock-api.js';
import { LocateCard } from './LocateCard.js';
import { createHttpApi } from '../api.js';

const api = () => createMockApi({ delayMs: 0 });
async function setup(client = api()) {
  const doc = (await client.listDocs())[0]!;
  const detail = await client.getDoc(doc.docId);
  const open = vi.fn();
  const view = render(
    <LocateCard api={client} detail={detail} onOpenSection={open} />,
  );
  return { client, detail, open, ...view };
}
const submit = (text = 'Lead pipes must be replaced within fifteen years.') => {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Find passage' }));
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it('shows accessible input, busy state, two labels, source styling and working citations', async () => {
  const { client, open, container } = await setup();
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const locate = client.locate.bind(client);
  vi.spyOn(client, 'locate').mockImplementation(async (...args) => {
    await gate;
    return locate(...args);
  });
  submit();
  expect(screen.getByRole('status').textContent).toContain(
    'Looking for the exact words',
  );
  expect(
    screen.getByRole('button', { name: 'Finding…' }).hasAttribute('disabled'),
  ).toBe(true);
  finish();
  await screen.findByText('Being removed by this bill');
  expect(screen.getByText('Already law, reprinted unchanged')).toBeTruthy();
  expect(container.querySelector('del')?.textContent).toContain(
    'within fifteen years',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Passage 1 source 1' }));
  expect(open).toHaveBeenCalledWith('sec-4/b', expect.any(HTMLElement));
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Clean Water Infrastructure Act > Section 4 > (b)',
    }),
  );
  expect(open).toHaveBeenCalledTimes(2);
});
it('copies a receipt and shows Copied feedback', async () => {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { writeText } });
  vi.stubGlobal('ClipboardItem', undefined);
  await setup();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy receipt for passage 1' }),
  );
  await screen.findByText('Copied');
  expect(writeText).toHaveBeenCalledWith(
    expect.stringContaining('[removed: within fifteen years]'),
  );
});
it('uses the never-verdict not-found wording and renders a cited note and earlier versions', async () => {
  const { open } = await setup();
  submit('unicorns in space');
  await screen.findByText(
    "We couldn't find these words in this version of the bill.",
  );
  expect(screen.queryByText(/false/i)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Topic source 1' }));
  expect(open).toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole('button', { name: 'Check earlier versions' }),
  );
  await screen.findByRole('link', { name: 'Introduced in House (2026-02-03)' });
  expect(screen.getAllByText(/Most of these words appear in:/)).toHaveLength(2);
});
it('shows disabled, errors, conditions, added styling, and unavailable versions', async () => {
  const client = api();
  const original = client.locate.bind(client);
  const locateSpy = vi
    .spyOn(client, 'locate')
    .mockImplementation(async (...args) => {
      const result = await original(...args);
      const match = result.matches[0]!;
      match.label = 'added';
      match.quote = [{ text: 'within ten years', status: 'inserted' }];
      match.conditions = 'Only after July 1.';
      match.amends = '42 U.S.C. 1395';
      return result;
    });
  const { container } = await setup(client);
  submit();
  await screen.findByText('Added by this bill');
  expect(container.querySelector('ins')?.textContent).toContain(
    'within ten years',
  );
  expect(screen.getByText('Changes 42 U.S.C. 1395')).toBeTruthy();
  vi.spyOn(client, 'locateVersions').mockResolvedValue({
    status: 'unavailable',
    versions: [],
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Check earlier versions' }),
  );
  await screen.findByText('Earlier versions are unavailable.');
  locateSpy.mockResolvedValue({
    status: 'disabled',
    matches: [],
    provider: 'none',
    model: 'none',
  });
  submit();
  await screen.findByText('This feature is unavailable on this server.');
  locateSpy.mockRejectedValue(new Error('offline'));
  submit();
  await screen.findByRole('alert');
});
it('cancels an in-flight request when unmounted', async () => {
  const client = api();
  let signal: AbortSignal | undefined;
  vi.spyOn(client, 'locate').mockImplementation((_id, _req, s) => {
    signal = s;
    return new Promise(() => undefined);
  });
  const { unmount } = await setup(client);
  submit();
  unmount();
  expect(signal?.aborted).toBe(true);
});
it('HTTP clients send contract requests and validate both response schemas', async () => {
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      Response.json({
        status: 'not-found',
        matches: [],
        provider: 'mock',
        model: 'test',
      }),
    )
    .mockResolvedValueOnce(Response.json({ status: 'ok', versions: [] }));
  const client = createHttpApi({ fetchImpl });
  expect(
    (await client.locate('doc/id', { text: 'garden grants' })).status,
  ).toBe('not-found');
  expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/docs/doc%2Fid/locate');
  expect(fetchImpl.mock.calls[0]?.[1]?.body).toBe('{"text":"garden grants"}');
  expect(
    (await client.locateVersions('doc/id', { text: 'garden grants' })).status,
  ).toBe('ok');
  expect(fetchImpl.mock.calls[1]?.[0]).toBe(
    '/api/docs/doc%2Fid/locate/versions',
  );
});
it('reports clipboard failures accessibly', async () => {
  vi.stubGlobal('navigator', {
    clipboard: { writeText: () => Promise.reject(new Error('denied')) },
  });
  vi.stubGlobal('ClipboardItem', undefined);
  await setup();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Copy receipt for passage 1' }),
  );
  await waitFor(() => {
    expect(screen.getByRole('alert').textContent).toContain('Could not copy');
  });
});
