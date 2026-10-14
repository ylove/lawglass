import { expect, test } from 'vitest';
import { assertHistoryUrl } from './allowlist.js';

test('accepts only the source’s exact HTTPS hosts', () => {
  expect(() => {
    assertHistoryUrl('govinfo', 'https://www.govinfo.gov/bulkdata/BILLSTATUS');
  }).not.toThrow();
  expect(() => {
    assertHistoryUrl('govinfo', new URL('https://WWW.GOVINFO.GOV:443/'));
  }).not.toThrow();
});
test.each([
  'invalid',
  'http://www.govinfo.gov/',
  'https://govinfo.gov/',
  'https://www.govinfo.gov:444/',
  'https://www.govinfo.gov.evil.test/',
  'https://evilwww.govinfo.gov/',
  'https://sub.www.govinfo.gov/',
  'https://www.govinfo.gov./',
  'https://www.govinfo.gov@evil.test/',
  'https://user@www.govinfo.gov/',
  'https://user:password@www.govinfo.gov/',
  'https://www.congress.gov/',
  'https://unitedstates.github.io/',
  'https://www.legislature.ohio.gov/',
  'file:///tmp/history.xml',
])('blocks %s by whole host equality', (input) => {
  expect(() => {
    assertHistoryUrl('govinfo', input);
  }).toThrow();
});
test('an unknown source cannot inherit another source’s hosts', () => {
  expect(() => {
    assertHistoryUrl('unknown', 'https://www.govinfo.gov/');
  }).toThrow();
});
