import * as cheerio from 'cheerio';
import { describe, expect, test } from 'vitest';
import type { BillEstimate } from '../core/cost/index.js';
import type { SafeFetchResult } from '../core/fetch/index.js';
import type { NormalizedDoc } from '../core/model/index.js';
import {
  downloadSize,
  QuotedDownloads,
  sameQuotedBill,
  type QuoteFacts,
  type QuotedDownload,
} from './quotes.js';

const facts: QuoteFacts = {
  contentHash: 'x',
  pages: null,
  sections: 3,
  tokens: 100,
  mode: 'whole',
  units: 2,
};

/** A download of `bytes` raw bytes whose parse holds `chars` characters of text. */
const download = (bytes: number, chars = 0): QuotedDownload => ({
  doc: {
    sections: [
      {
        id: 's',
        level: 1,
        spans: [{ text: 'x'.repeat(chars), status: 'unchanged' }],
        children: [],
      },
    ],
    definitions: [],
  } as unknown as NormalizedDoc,
  fetched: { bytes: new Uint8Array(bytes) } as SafeFetchResult,
  attachment: undefined,
  publicFacts: facts,
  estimates: {},
});

describe('QuotedDownloads', () => {
  test('keeps a download for reuse, per reader and URL', () => {
    const store = new QuotedDownloads();
    store.put('alice', 'u', download(10));
    expect(store.get('alice', 'u')).toBeDefined();
    expect(store.get('alice', 'u')).toBeDefined();
    expect(store.get('bob', 'u')).toBeUndefined();
    expect(store.get('alice', 'v')).toBeUndefined();
    expect(store.get(undefined, 'u')).toBeUndefined();
  });

  test('keys cannot collide across the reader and URL boundary', () => {
    const store = new QuotedDownloads();
    store.put('a', 'b,c', download(1));
    expect(store.get('a,b', 'c')).toBeUndefined();
  });

  test('a newer measure replaces the older and frees its bytes', () => {
    const store = new QuotedDownloads();
    store.put('a', 'u', download(10));
    const before = store.totalBytes;
    store.put('a', 'u', download(10));
    expect(store.size).toBe(1);
    expect(store.totalBytes).toBe(before);
  });

  test('holds no parse-time DOM: it is dropped before storing', () => {
    const store = new QuotedDownloads();
    const html = '<html><body><p>hello</p></body></html>';
    const withDom = download(html.length);
    withDom.fetched = {
      bytes: new TextEncoder().encode(html),
      preparedHtml: { dom: cheerio.load(html) },
    } as unknown as SafeFetchResult;
    const stored = store.put('a', 'u', withDom);
    expect(stored.fetched.preparedHtml).toBeUndefined();
    expect(store.get('a', 'u')?.fetched.preparedHtml).toBeUndefined();
    // The caller's own object is not changed.
    expect(withDom.fetched.preparedHtml).toBeDefined();
  });

  test('sizes an entry from its bytes and the parsed text, two bytes per character', () => {
    expect(downloadSize(download(100, 10))).toBe(120);
    const withDefinitions = download(0, 0);
    (withDefinitions.doc as { definitions: unknown }).definitions = [
      { term: 'ab', text: 'cde' },
    ];
    (withDefinitions.doc.sections[0] as { heading: string }).heading = 'hh';
    expect(downloadSize(withDefinitions)).toBe(2 * (2 + 5));
    const nested = download(0, 1);
    (nested.doc.sections[0] as { children: unknown }).children = [
      { spans: [{ text: 'yy' }], children: [] },
    ];
    expect(downloadSize(nested)).toBe(2 * 3);
  });

  test('a big parse counts against the byte budget, not only the raw bytes', () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 100, 10);
    store.put('a', 'u', download(10, 20)); // 50
    store.put('b', 'u', download(10, 20)); // 50
    store.put('c', 'u', download(10, 20)); // pushes the oldest out
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.totalBytes).toBeLessThanOrEqual(100);
  });

  test('expires after the ttl, on get and on put', () => {
    let t = 0;
    const store = new QuotedDownloads(() => t, 100);
    store.put('a', 'u', download(10));
    t = 100;
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('touch restarts the age', () => {
    let t = 0;
    const store = new QuotedDownloads(() => t, 100);
    store.put('a', 'u', download(10));
    t = 90;
    store.touch('a', 'u');
    t = 150;
    expect(store.get('a', 'u')).toBeDefined();
    t = 190;
    expect(store.get('a', 'u')).toBeUndefined();
    store.touch('nobody', 'u');
  });

  test('evicts oldest first past the entry cap', () => {
    const store = new QuotedDownloads(() => 0, 100, 2, 1000, 10);
    for (const id of ['a', 'b', 'c']) store.put(id, 'u', download(1));
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.get('c', 'u')).toBeDefined();
  });

  test('is bounded by bytes, and never keeps one bigger than the budget', () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 100, 10);
    store.put('a', 'u', download(30));
    store.put('b', 'u', download(30));
    store.put('c', 'u', download(30));
    store.put('d', 'u', download(30));
    expect(store.totalBytes).toBeLessThanOrEqual(100);
    expect(store.get('a', 'u')).toBeUndefined();
    store.put('huge', 'u', download(1000));
    expect(store.get('huge', 'u')).toBeUndefined();
  });

  test("one reader's many downloads never evict another reader's", () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 10_000, 3);
    store.put('alice', 'u', download(1));
    for (let i = 0; i < 40; i++) store.put('bob', `u${String(i)}`, download(1));
    expect(store.get('alice', 'u')).toBeDefined();
    // Bob keeps only his three newest.
    expect(store.get('bob', 'u39')).toBeDefined();
    expect(store.get('bob', 'u37')).toBeDefined();
    expect(store.get('bob', 'u36')).toBeUndefined();
    expect(store.size).toBe(4);
  });
});

describe('sameQuotedBill', () => {
  const est = { total: { low: 1 } } as unknown as BillEstimate;
  const quoted = { facts, estimates: { default: est } };
  const measured = { publicFacts: facts, estimates: { default: est } };

  test('ignores the content hash, not the size', () => {
    expect(
      sameQuotedBill(quoted, {
        ...measured,
        publicFacts: { ...facts, contentHash: 'y' },
      }),
    ).toBe(true);
    expect(
      sameQuotedBill(quoted, {
        ...measured,
        publicFacts: { ...facts, tokens: 101 },
      }),
    ).toBe(false);
    expect(
      sameQuotedBill(quoted, {
        ...measured,
        publicFacts: { ...facts, sections: 4 },
      }),
    ).toBe(false);
  });

  test('requires the whole estimate to agree, not only the facts', () => {
    const other = { total: { low: 2 } } as unknown as BillEstimate;
    expect(
      sameQuotedBill(quoted, { ...measured, estimates: { default: other } }),
    ).toBe(false);
  });
});
