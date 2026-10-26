// Contract additions for #346 and #164: DocDetail.historyLinks and BillHistory.officialTitle.
// Both are optional, so every stored or served shape from before still parses.
import { describe, expect, it } from 'vitest';
import { BillHistory, DocDetail, EMPTY_METADATA } from './index.js';

const history = { versions: [], actions: [], amendments: [], sources: [] };

describe('BillHistory.officialTitle', () => {
  it('is optional: a history without it, or with the legacy extra key shape, parses', () => {
    expect(BillHistory.parse(history)).not.toHaveProperty('officialTitle');
    expect(
      BillHistory.parse({ ...history, officialTitle: 'To create grants.' })
        .officialTitle,
    ).toBe('To create grants.');
  });

  it("accepts every title the adapters write (2,000 characters plus the sanitizer's ellipsis)", () => {
    const sanitized = `${'x'.repeat(2000)}…`;
    expect(
      BillHistory.parse({ ...history, officialTitle: sanitized }).officialTitle,
    ).toBe(sanitized);
    expect(
      BillHistory.safeParse({ ...history, officialTitle: 'x'.repeat(4001) })
        .success,
    ).toBe(false);
  });
});

describe('DocDetail.historyLinks', () => {
  const base = {
    doc: {
      docId: 'a'.repeat(64),
      label: 'T',
      sourceUrl: 'https://www.govinfo.gov/x.xml',
      format: 'xml',
      title: null,
      billNumber: null,
      ingestedAt: '2026-01-01T00:00:00.000Z',
      lastUsedAt: '2026-01-01T00:00:00.000Z',
      backend: 'local',
    },
    metadata: EMPTY_METADATA,
    outline: [],
    externalRefs: [],
    warnings: [],
    hasLineNumbers: false,
  };
  const parse = (extra: object) => DocDetail.safeParse({ ...base, ...extra });

  it('is optional and accepts either or both https links', () => {
    expect(parse({}).success).toBe(true);
    expect(
      parse({
        historyLinks: {
          actions: 'https://www.congress.gov/bill/x/all-actions',
        },
      }).success,
    ).toBe(true);
    expect(parse({ historyLinks: {} }).success).toBe(true);
  });

  it('refuses non-https links', () => {
    expect(
      parse({ historyLinks: { actions: 'http://www.congress.gov/x' } }).success,
    ).toBe(false);
    expect(
      parse({ historyLinks: { amendments: 'javascript:alert(1)' } }).success,
    ).toBe(false);
  });
});
