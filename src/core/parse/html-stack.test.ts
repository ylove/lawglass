import { load } from 'cheerio';
import { afterEach, expect, it, vi } from 'vitest';
import { parseHtml, prepareHtml } from './html.js';

vi.mock('cheerio', async (importOriginal) => {
  const original = await importOriginal<typeof import('cheerio')>();
  return { ...original, load: vi.fn(original.load) };
});

afterEach(() => vi.restoreAllMocks());

const options = {
  sourceUrl: 'https://example.gov/bill.html',
  fetchedAt: '2026-10-13T00:00:00.000Z',
};

it('contains a parse5 stack overflow when preparing a DOM', () => {
  const cause = new RangeError('Maximum call stack size exceeded');
  vi.mocked(load).mockImplementationOnce(() => {
    throw cause;
  });
  expect(() => prepareHtml('<p>Bill</p>')).toThrow(
    expect.objectContaining({
      code: 'TOO_LARGE',
      message: 'HTML nesting depth limit exceeded.',
      cause,
    }),
  );
});

it('contains stack exhaustion when traversing a supplied DOM', () => {
  const dom = load('<div>Bill</div>');
  const root = dom.root()[0]!;
  const element = dom('div')[0]!;
  // Build without parse5 so this tests the fallback independently of the pre-scan.
  // A supplied DOM is also allowed by the ingest wrapper's prepare-once path.
  let child = element;
  for (let depth = 0; depth < 20_000; depth++) {
    const parent = element.cloneNode(false);
    parent.children = [child];
    child.parent = parent;
    child = parent;
  }
  root.children = [child];
  child.parent = root;
  expect(() =>
    parseHtml('<div>Bill</div>', {
      ...options,
      preparedHtml: { dom, warnings: [] },
    }),
  ).toThrow(
    expect.objectContaining({
      code: 'TOO_LARGE',
      message: 'HTML nesting depth limit exceeded.',
      cause: expect.any(RangeError) as unknown,
    }),
  );
});
