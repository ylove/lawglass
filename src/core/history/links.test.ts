import { describe, expect, it } from 'vitest';
import { historyLinksFor } from './links.js';
import type { BillHistory } from '../model/index.js';

const withSource = (url: string): BillHistory => ({
  versions: [],
  actions: [],
  amendments: [],
  sources: [
    { host: new URL(url).host, url, fetchedAt: '2026-01-01T00:00:00Z' },
  ],
});

describe('historyLinksFor', () => {
  it('builds Congress.gov links from a GovInfo package URL', () => {
    expect(
      historyLinksFor(
        'https://www.govinfo.gov/content/pkg/BILLS-119s1582enr/xml/BILLS-119s1582enr.xml',
        undefined,
      ),
    ).toEqual({
      actions:
        'https://www.congress.gov/bill/119th-congress/senate-bill/1582/all-actions',
      amendments:
        'https://www.congress.gov/bill/119th-congress/senate-bill/1582/amendments',
    });
  });

  it('uses the recorded BILLSTATUS source, with the right ordinal and slug', () => {
    const links = historyLinksFor(
      'https://example.gov/anything.xml',
      withSource(
        'https://www.govinfo.gov/bulkdata/BILLSTATUS/112/hjres/BILLSTATUS-112hjres21.xml',
      ),
    );
    expect(links.actions).toBe(
      'https://www.congress.gov/bill/112th-congress/house-joint-resolution/21/all-actions',
    );
  });

  it.each([
    [101, 'hconres', '101st-congress/house-concurrent-resolution'],
    [102, 'sres', '102nd-congress/senate-resolution'],
    [103, 'hr', '103rd-congress/house-bill'],
    [111, 'sjres', '111th-congress/senate-joint-resolution'],
  ])('congress %i %s', (congress, type, path) => {
    const url = `https://www.govinfo.gov/bulkdata/BILLSTATUS/${String(congress)}/${type}/BILLSTATUS-${String(congress)}${type}7.xml`;
    expect(historyLinksFor(url, undefined).amendments).toBe(
      `https://www.congress.gov/bill/${path}/7/amendments`,
    );
  });

  it('links Ohio to the verified status page only', () => {
    expect(
      historyLinksFor(
        'https://search-prod.lis.state.oh.us/api/v2/general_assembly_136/legislation/hb96/05_EN/pdf/',
        undefined,
      ),
    ).toEqual({
      actions: 'https://www.legislature.ohio.gov/legislation/136/hb96/status',
    });
    expect(
      historyLinksFor(
        'https://www.legislature.ohio.gov/legislation/136/sb1',
        undefined,
      ).actions,
    ).toBe('https://www.legislature.ohio.gov/legislation/136/sb1/status');
  });

  it.each([
    'https://nyassembly.gov/leg/?bn=A1',
    'https://example.gov/bill.pdf',
    'not a url',
    'https://www.govinfo.gov/content/pkg/BILLS-119s1582enr/../x.xml',
    'https://www.congress.gov/bill/119th-congress/senate-bill/abc',
    'https://evil.example/www.legislature.ohio.gov/legislation/136/hb96',
    'http://www.legislature.ohio.gov/legislation/136/hb96',
  ])('gives no links for %s', (url) => {
    expect(historyLinksFor(url, undefined)).toEqual({});
  });
});
