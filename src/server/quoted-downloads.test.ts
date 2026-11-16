import * as cheerio from 'cheerio';
import { makeSectionedText } from '../../tests/synth/index.js';
import { parseText } from '../core/parse/index.js';
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

/** A download of `bytes` raw bytes; with `chars`, its parse is one section holding that much text. */
const download = (bytes: number, chars?: number): QuotedDownload => ({
  doc: {
    sections:
      chars === undefined
        ? []
        : [
            {
              id: 's',
              level: 1,
              spans: [{ text: 'x'.repeat(chars), status: 'unchanged' }],
              children: [],
            },
          ],
    definitions: [],
    externalRefs: [],
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

  test('sizes an entry from its bytes, its text and the overhead of each span, section and reference', () => {
    // 100 raw bytes, one section (200) with one span (100) of 10 chars (20).
    expect(downloadSize(download(100, 10))).toBe(100 + 200 + 100 + 20);
    const withDefinitions = download(0, 0);
    (withDefinitions.doc as { definitions: unknown }).definitions = [
      { term: 'ab', text: 'cde' },
    ];
    (withDefinitions.doc?.sections[0] as { heading: string }).heading = 'hh';
    expect(downloadSize(withDefinitions)).toBe(200 + 4 + 100 + (100 + 10));
    const nested = download(0, 1);
    (nested.doc?.sections[0] as { children: unknown }).children = [
      { spans: [{ text: 'yy' }], children: [] },
    ];
    expect(downloadSize(nested)).toBe(200 + 100 + 2 + (200 + 100 + 4));
    const refs = download(0, 0);
    (refs.doc as { externalRefs: unknown }).externalRefs = [
      { text: 'ab', citation: 'c', sectionIds: ['s1', 's2'] },
    ];
    expect(downloadSize(refs)).toBe(200 + 100 + (100 + 6 + 80));
  });

  test('is at least text at two bytes a character plus 100 bytes a span, for a real parse', () => {
    const sample = makeSectionedText();
    const doc = parseText(sample.bytes, {
      sourceUrl: 'https://example.gov/a.txt',
      fetchedAt: '2026-10-13T00:00:00.000Z',
    });
    let spans = 0;
    let chars = 0;
    const walk = (sections: NormalizedDoc['sections']): void => {
      for (const section of sections) {
        for (const span of section.spans) {
          spans++;
          chars += span.text.length;
        }
        walk(section.children);
      }
    };
    walk(doc.sections);
    expect(spans).toBeGreaterThan(5);
    const size = downloadSize({
      ...download(sample.bytes.byteLength),
      doc,
    });
    expect(size).toBeGreaterThanOrEqual(
      sample.bytes.byteLength + 2 * chars + 100 * spans,
    );
  });

  test('a big parse counts against the byte budget, not only the raw bytes', () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 800, 10, 800);
    store.put('a', 'u', download(10, 20)); // 10 + 200 + 100 + 40 = 350
    store.put('b', 'u', download(10, 20));
    store.put('c', 'u', download(10, 20)); // pushes the oldest out
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.totalBytes).toBeLessThanOrEqual(800);
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
    const store = new QuotedDownloads(() => 0, 100, 10, 100, 10, 100);
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

describe("a reader's byte share", () => {
  test("one reader's large downloads never evict another reader's entry", () => {
    // Budget 400, share 100: a reader may hold 100 bytes, however much room is left overall.
    const store = new QuotedDownloads(() => 0, 100, 20, 400, 10, 100);
    store.put('alice', 'u', download(10));
    for (let i = 0; i < 10; i++)
      store.put('bob', `u${String(i)}`, download(60));
    expect(store.get('alice', 'u')).toBeDefined();
    // Bob keeps only what his share allows: the newest.
    expect(store.get('bob', 'u9')).toBeDefined();
    expect(store.get('bob', 'u8')).toBeUndefined();
  });

  test('a parse too big for the share is dropped: the bytes-only entry counts at raw size', () => {
    // Share 1000: 100 raw bytes with a 100,000-character parse does not fit, the bytes do.
    const store = new QuotedDownloads(() => 0, 100, 20, 4000, 10, 1000);
    const full = download(100, 100_000);
    const returned = store.put('alice', 'u', full);
    // This ingest still has its parse; the next one gets bytes only.
    expect(returned.doc).toBeDefined();
    const stored = store.get('alice', 'u');
    expect(stored?.doc).toBeUndefined();
    expect(stored?.fetched.bytes.byteLength).toBe(100);
    expect(stored?.publicFacts).toBe(full.publicFacts);
    expect(stored?.estimates).toBe(full.estimates);
    expect(store.totalBytes).toBe(100);
    expect(downloadSize({ ...full, doc: undefined })).toBe(100);
  });

  test("raw bytes bigger than a reader's share are not stored, and evicts nobody", () => {
    const store = new QuotedDownloads(() => 0, 100, 20, 400, 10, 100);
    store.put('alice', 'u', download(10));
    const big = download(500);
    expect(store.put('bob', 'big', big).fetched.bytes.byteLength).toBe(500);
    expect(store.get('bob', 'big')).toBeUndefined();
    expect(store.get('alice', 'u')).toBeDefined();
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
