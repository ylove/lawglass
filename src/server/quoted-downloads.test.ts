import { describe, expect, test } from 'vitest';
import type { SafeFetchResult } from '../core/fetch/index.js';
import type { NormalizedDoc } from '../core/model/index.js';
import {
  QuotedDownloads,
  sameQuotedBill,
  type QuoteFacts,
  type QuotedDownload,
} from './quotes.js';

const download = (bytes: number): QuotedDownload => ({
  doc: {} as NormalizedDoc,
  fetched: { bytes: new Uint8Array(bytes) } as SafeFetchResult,
  attachment: undefined,
  publicFacts: {} as QuoteFacts,
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
    const newer = download(5);
    store.put('a', 'u', download(10));
    store.put('a', 'u', newer);
    expect(store.get('a', 'u')).toBe(newer);
    expect(store.size).toBe(1);
    expect(store.totalBytes).toBe(10);
  });

  test('expires after the ttl', () => {
    let t = 0;
    const store = new QuotedDownloads(() => t, 100);
    store.put('a', 'u', download(10));
    t = 100;
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('evicts oldest first past the entry cap', () => {
    const store = new QuotedDownloads(() => 0, 100, 2);
    for (const id of ['a', 'b', 'c']) store.put(id, 'u', download(1));
    expect(store.get('a', 'u')).toBeUndefined();
    expect(store.get('c', 'u')).toBeDefined();
  });

  test('is bounded by bytes, and never keeps one bigger than the budget', () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 100);
    store.put('a', 'u', download(30));
    store.put('b', 'u', download(30));
    expect(store.totalBytes).toBeLessThanOrEqual(100);
    expect(store.get('a', 'u')).toBeUndefined();
    store.put('huge', 'u', download(1000));
    expect(store.get('huge', 'u')).toBeUndefined();
  });
});

describe('sameQuotedBill', () => {
  const facts: QuoteFacts = {
    contentHash: 'x',
    pages: null,
    sections: 3,
    tokens: 100,
    mode: 'whole',
    units: 2,
  };
  test('ignores the content hash, not the size', () => {
    expect(sameQuotedBill(facts, { ...facts, contentHash: 'y' })).toBe(true);
    expect(sameQuotedBill(facts, { ...facts, tokens: 101 })).toBe(false);
    expect(sameQuotedBill(facts, { ...facts, sections: 4 })).toBe(false);
  });
});
