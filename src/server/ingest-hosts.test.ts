import { expect, test } from 'vitest';
import { BRAND, envVar } from '../core/brand.js';
import { HISTORY_SOURCES } from '../core/history/resolve.js';
import { LEGISLATORS_URLS } from '../core/sponsors/legislators.js';
import {
  checkIngestFetchHost,
  checkIngestHost,
  DEFAULT_INGEST_HOSTS,
  ingestHosts,
} from './ingest-hosts.js';

test('fetch policy keeps every registered history host with its HTTPS policy', () => {
  const hosts = new Set(['example.gov']);
  for (const source of HISTORY_SOURCES) {
    for (const host of source.hosts) {
      expect(() => {
        checkIngestFetchHost(new URL(`https://${host}/record`), hosts);
      }).not.toThrow();
      expect(() => {
        checkIngestFetchHost(new URL(`http://${host}/record`), hosts);
      }).toThrow(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
    }
  }
  expect(() => {
    checkIngestFetchHost(new URL('https://example.gov/bill'), hosts);
  }).not.toThrow();
  expect(() => {
    checkIngestFetchHost(new URL('https://outside.example/bill'), hosts);
  }).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('fetch policy keeps only the published sponsor directory files', () => {
  for (const url of Object.values(LEGISLATORS_URLS))
    expect(() => {
      checkIngestFetchHost(new URL(url), new Set());
    }).not.toThrow();
  for (const url of [
    'https://unitedstates.github.io/other.json',
    LEGISLATORS_URLS.current.replace('https:', 'http:'),
  ])
    expect(() => {
      checkIngestFetchHost(new URL(url), new Set());
    }).toThrow();
});

test.each(DEFAULT_INGEST_HOSTS)('allows exact official host %s', (host) => {
  expect(() => {
    checkIngestHost(`https://${host}/bill`, ingestHosts({}));
  }).not.toThrow();
});

test.each([
  'https://www.nxleg.example/bill',
  'https://www.palegis.us/bill',
  'https://127.0.0.1/bill',
  'https://[::1]/bill',
  'https://govinfo.gov@evil.example/bill',
  'https://evil.govinfo.gov/bill',
  'https://govinfo.gov.evil.example/bill',
])('refuses %s with the roadmap message', (url) => {
  expect(() => {
    checkIngestHost(url, ingestHosts({}));
  }).toThrow(
    expect.objectContaining({
      code: 'INVALID_INPUT',
      userMessage: `${BRAND.displayName} currently reads U.S. federal bills (congress.gov, govinfo.gov) Ohio legislation (legislature.ohio.gov), New York bills (nysenate.gov, nyassembly.gov), and New Jersey bills (njleg.state.nj.us, pub.njleg.gov). Other states are on the roadmap.`,
    }),
  );
});

test('compares case-insensitively and overrides rather than extends defaults', () => {
  expect(() => {
    checkIngestHost('https://WWW.GOVINFO.GOV/bill', ingestHosts({}));
  }).not.toThrow();
  const hosts = ingestHosts({
    [envVar('INGEST_HOSTS')]: ' Example.GOV, other.gov, , ',
  });
  expect([...hosts]).toEqual(['example.gov', 'other.gov']);
  expect(() => {
    checkIngestHost('https://EXAMPLE.gov/bill', hosts);
  }).not.toThrow();
  expect(() => {
    checkIngestHost('https://govinfo.gov/bill', hosts);
  }).toThrow();
  expect(ingestHosts({ [envVar('INGEST_HOSTS')]: '  ' })).toEqual(
    ingestHosts({}),
  );
});

test.each(['nysenate.gov', 'www.nysenate.gov'])(
  'accepts %s when pasted but never fetches it',
  (host) => {
    const url = new URL(`https://${host}/legislation/bills/2025/S1234`);
    expect(() => {
      checkIngestHost(url.href, ingestHosts({}));
    }).not.toThrow();
    expect(() => {
      checkIngestFetchHost(url, ingestHosts({}));
    }).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
  },
);

test.each(['nyassembly.gov', 'www.nyassembly.gov', 'legislation.nysenate.gov'])(
  'keeps official NY text fetch host %s',
  (host) => {
    expect(() => {
      checkIngestFetchHost(new URL(`https://${host}/bill`), ingestHosts({}));
    }).not.toThrow();
  },
);

test.each([
  'njleg.state.nj.us',
  'www.njleg.state.nj.us',
  'njleg.gov',
  'www.njleg.gov',
  'pub.njleg.gov',
  'pub.njleg.state.nj.us',
])('accepts the New Jersey host %s when pasted', (host) => {
  expect(() => {
    checkIngestHost(`https://${host}/bill-search/2026/S1000`, ingestHosts({}));
  }).not.toThrow();
  expect(DEFAULT_INGEST_HOSTS).toContain(host);
});

test('fetches only bill text and the bill-text JSON from New Jersey hosts', () => {
  const hosts = ingestHosts({});
  for (const ok of [
    'https://pub.njleg.gov/Bills/2026/S1000/1000_I1.PDF',
    'https://pub.njleg.state.nj.us/bills/2024/S1500/1446_R2.PDF',
    'https://www.njleg.state.nj.us/api/billDetailHist/billText/S1000/2026',
  ])
    expect(() => {
      checkIngestFetchHost(new URL(ok), hosts);
    }).not.toThrow();
  for (const bad of [
    'https://www.njleg.state.nj.us/bill-search/2026/S1000',
    'https://njleg.gov/api/billDetailHist/billText/S1000/2026',
    'https://www.njleg.state.nj.us/api/billDetail/billSponsors/S1000/2026',
    'http://pub.njleg.gov/Bills/2026/S1000/1000_I1.PDF',
    'https://pub.njleg.gov:8443/Bills/2026/S1000/1000_I1.PDF',
    'https://pub.njleg.gov/other/file.pdf',
  ])
    expect(() => {
      checkIngestFetchHost(new URL(bad), hosts);
    }).toThrow();
});

test.each([
  'https://evilnjleg.gov/bill',
  'https://njleg.gov.evil.example/bill',
  'https://pub.njleg.gov@evil.example/bill',
  'https://notpub.njleg.gov/bill',
])('refuses the lookalike %s', (url) => {
  expect(() => {
    checkIngestHost(url, ingestHosts({}));
  }).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});
