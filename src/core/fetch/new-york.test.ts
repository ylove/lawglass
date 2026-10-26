import { expect, test } from 'vitest';
import { resolveNewYork, assertNewYorkFetch } from './new-york.js';

const assembly = 'https://nyassembly.gov/leg/?bn=S01234&term=2025&Text=Y';
const pdf = 'https://legislation.nysenate.gov/pdf/bills/2025/S1234';
test.each([
  ['https://www.nysenate.gov/legislation/bills/2025/S1234', assembly, true],
  [
    'https://nysenate.gov/legislation/bills/2025/s01234/?foo=bar#text',
    assembly,
    true,
  ],
  [
    'https://www.nysenate.gov/legislation/bills/2025/S1234/text',
    assembly,
    true,
  ],
  ['https://www.nysenate.gov/legislation/bills/2025/S1234A', `${pdf}A`, false],
  [
    'https://www.nysenate.gov/legislation/bills/2025/S1234/amendment/B',
    `${pdf}B`,
    false,
  ],
  [
    'https://www.nysenate.gov/legislation/bills/2025/S1234/amendment/0',
    pdf,
    false,
  ],
  [
    'https://www.nysenate.gov/legislation/bills/2025/A1234c',
    pdf.replace('S1234', 'A1234C'),
    false,
  ],
  [
    'https://nyassembly.gov/leg/?default_fld=&leg_video=&bn=S01234&term=2025&Summary=Y&Text=Y',
    assembly,
    true,
  ],
  [
    'https://www.nyassembly.gov/leg?bn=S1234A&term=2025&Memo=Y',
    `${pdf}A`,
    false,
  ],
  [
    'https://nyassembly.gov/leg/?bn=A00001&term=2023',
    'https://nyassembly.gov/leg/?bn=A00001&term=2023&Text=Y',
    true,
  ],
  [pdf, pdf, false],
  [`${pdf}A.pdf`, `${pdf}A`, false],
])('maps %s without fetching the landing page', (input, textUrl, latest) => {
  expect(resolveNewYork(input)).toEqual({ textUrl, latest });
});
test.each([
  'http://www.nysenate.gov/legislation/bills/2025/S1234',
  'https://www.nysenate.gov:444/legislation/bills/2025/S1234',
  'https://user@nyassembly.gov/leg/?bn=S1234&term=2025',
  'https://nyassembly.gov/leg/?bn=S1234&bn=S9876&term=2025',
  'https://nyassembly.gov/leg/?bn=S1234&term=2025&term=2023',
  'https://nyassembly.gov/leg/?bn=../../../evil&term=2025',
  'https://nyassembly.gov/leg/?bn=S1234',
  'https://nyassembly.gov/other/?bn=S1234&term=2025',
  'https://www.nysenate.gov/legislation/bills/2025/S1234A/amendment/B',
  'https://www.nysenate.gov/legislation/bills/2025/S0',
  'https://www.nysenate.gov/legislation/bills/2025/S1234/unknown',
  'https://www.nysenate.gov/legislation/bills/2025/../2025/S1234',
  'https://www.nysenate.gov/legislation/bills/2025/%531234',
  'https://www.nysenate.gov/legislation/bills/2025\\S1234',
  'https://legislation.nysenate.gov/api/3/bills/2025/S1234',
  'https://legislation.nysenate.gov/pdf/bills/9999/S1234',
  'https://nyassembly.gov/leg/?bn=S1234&term=no',
])('rejects malformed/unsupported NY URLs before fetch: %s', (input) => {
  expect(() => resolveNewYork(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});
test.each([
  'not a URL',
  'https://example.com/a',
  'https://nyassembly.gov.evil.test/leg/',
  'https://evil.nysenate.gov/a',
])('leaves other hosts to ordinary SSRF-guarded fetching: %s', (input) => {
  expect(resolveNewYork(input)).toBeUndefined();
});
test('full text fetch policy rejects redirects away from exact HTTPS sources', () => {
  for (const input of [
    assembly,
    pdf,
    assembly.replace('nyassembly.gov', 'www.nyassembly.gov'),
  ])
    expect(() => {
      assertNewYorkFetch(new URL(input));
    }).not.toThrow();
  for (const input of [
    'https://localhost/a',
    'https://nyassembly.gov.evil.test/a',
    'http://nyassembly.gov/a',
    'https://u:p@nyassembly.gov/a',
    'https://nyassembly.gov:8443/a',
    'https://www.nysenate.gov/a',
  ])
    expect(() => {
      assertNewYorkFetch(new URL(input));
    }).toThrow(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
});
