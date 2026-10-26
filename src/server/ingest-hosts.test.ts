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
  'https://pub.njleg.gov/bill',
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
      userMessage: `${BRAND.displayName} currently reads U.S. federal bills (congress.gov, govinfo.gov) Ohio legislation (legislature.ohio.gov), and New York bills (nysenate.gov, nyassembly.gov). Other states are on the roadmap.`,
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
