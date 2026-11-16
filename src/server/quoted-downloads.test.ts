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
});

describe('QuotedDownloads', () => {
  test('hands a download over once', () => {
    const store = new QuotedDownloads();
    store.put('a', download(10));
    expect(store.take('a')).toBeDefined();
    expect(store.take('a')).toBeUndefined();
    expect(store.totalBytes).toBe(0);
  });

  test('expires after the ttl', () => {
    let t = 0;
    const store = new QuotedDownloads(() => t, 100);
    store.put('a', download(10));
    t = 100;
    expect(store.take('a')).toBeUndefined();
    expect(store.size).toBe(0);
  });

  test('evicts oldest first past the entry cap', () => {
    const store = new QuotedDownloads(() => 0, 100, 2);
    for (const id of ['a', 'b', 'c']) store.put(id, download(1));
    expect(store.take('a')).toBeUndefined();
    expect(store.take('c')).toBeDefined();
  });

  test('is bounded by bytes, and never keeps one bigger than the budget', () => {
    const store = new QuotedDownloads(() => 0, 100, 10, 100);
    store.put('a', download(30));
    store.put('b', download(30));
    expect(store.totalBytes).toBeLessThanOrEqual(100);
    expect(store.take('a')).toBeUndefined();
    store.put('huge', download(1000));
    expect(store.take('huge')).toBeUndefined();
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
