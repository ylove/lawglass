import { expect, test } from 'vitest';
import {
  assertPennsylvaniaFetch,
  choosePennsylvaniaText,
  pennsylvaniaPageUrl,
  resolvePennsylvania,
} from './pennsylvania.js';

const text = (year: number, session: number, bill: string, pn: string) =>
  `https://www.palegis.us/legislation/bills/text/PDF/${String(year)}/${String(session)}/${bill}/PN${pn}`;

test.each([
  ['https://www.palegis.us/legislation/bills/2025/hb2443', 'HB', 2443, 0],
  ['https://palegis.us/legislation/bills/2025/sr374', 'SR', 374, 0],
  [
    'https://www.palegis.us/legislation/bills/2025/HR0607/?utm=1#history',
    'HR',
    607,
    0,
  ],
  ['https://www.palegis.us/legislation/bills/2025/sb1273', 'SB', 1273, 0],
  ['https://www.palegis.us/legislation/bills/2023/1/hb1', 'HB', 1, 1],
])(
  'bill page %s asks for the newest printer number',
  (input, type, number, session) => {
    const resolved = resolvePennsylvania(input);
    expect(resolved).toEqual({
      lookup: {
        year: Number(/bills\/(\d{4})/.exec(input)?.[1]),
        session,
        type,
        number,
      },
    });
  },
);

test('a bill page maps back to the site address without padding', () => {
  expect(
    pennsylvaniaPageUrl({ year: 2025, session: 0, type: 'SR', number: 374 }),
  ).toBe('https://www.palegis.us/legislation/bills/2025/sr374');
  expect(
    pennsylvaniaPageUrl({ year: 2023, session: 1, type: 'HB', number: 1 }),
  ).toBe('https://www.palegis.us/legislation/bills/2023/1/hb1');
});

test.each([
  // Every format maps to the PDF, with the zero padding the site requires.
  [
    'https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB2443/PN4082',
    text(2025, 0, 'HB2443', '4082'),
  ],
  [
    'https://www.palegis.us/legislation/bills/text/HTM/2025/0/HB2443/PN4082',
    text(2025, 0, 'HB2443', '4082'),
  ],
  [
    'https://palegis.us/legislation/bills/text/DOC/2025/0/SB1273/PN2003',
    text(2025, 0, 'SB1273', '2003'),
  ],
  [
    'https://www.palegis.us/legislation/bills/text/PDF/2025/0/SR0374/PN1942',
    text(2025, 0, 'SR0374', '1942'),
  ],
  [
    'https://www.palegis.us/legislation/bills/text/pdf/2025/0/sr374/pn1942',
    text(2025, 0, 'SR0374', '1942'),
  ],
  [
    'https://www.palegis.us/legislation/bills/text/PDF/2025/0/SB0605/PN0613',
    text(2025, 0, 'SB0605', '0613'),
  ],
  [
    'https://www.palegis.us/legislation/bills/text/PDF/2023/1/HB0001/PN0006',
    text(2023, 1, 'HB0001', '0006'),
  ],
  // The older site's links.
  [
    'https://www.legis.state.pa.us/cfdocs/legis/PN/Public/btCheck.cfm?txtType=HTM&sessYr=2025&sessInd=0&billBody=H&billTyp=B&billNbr=2443&pn=4082',
    text(2025, 0, 'HB2443', '4082'),
  ],
  [
    'https://www.legis.state.pa.us/newSiteRedirect.cfm?targetPage=cfdocs/legis/PN/Public/btCheck.cfm&txtType=PDF&sessYr=2025&sessInd=0&billBody=S&billTyp=R&billNbr=374&pn=1942',
    text(2025, 0, 'SR0374', '1942'),
  ],
  [
    'https://www.legis.state.pa.us/WU01/LI/BI/BT/2025/0/HB2443P4082.pdf',
    text(2025, 0, 'HB2443', '4082'),
  ],
])('named printer number %s is read from the PDF', (input, textUrl) => {
  expect(resolvePennsylvania(input)).toEqual({ textUrl });
});

test.each([
  'https://www.legis.state.pa.us/cfdocs/billinfo/billinfo.cfm?syear=2025&sind=0&body=H&type=B&bn=2443',
  'https://www.legis.state.pa.us/cfdocs/legis/PN/Public/btCheck.cfm?txtType=HTM&sessYr=2025&sessInd=0&billBody=H&billTyp=B&billNbr=2443',
])('old site link %s without a printer number asks for the newest', (input) => {
  expect(resolvePennsylvania(input)).toEqual({
    lookup: { year: 2025, session: 0, type: 'HB', number: 2443 },
  });
});

test("non-Pennsylvania hosts and non-URLs are not this resolver's", () => {
  expect(
    resolvePennsylvania('https://www.njleg.gov/bill-search/2024/S1000'),
  ).toBeUndefined();
  expect(resolvePennsylvania('not a url')).toBeUndefined();
  expect(
    resolvePennsylvania('https://evilpalegis.us/legislation/bills/2025/hb1'),
  ).toBeUndefined();
  expect(
    resolvePennsylvania(
      'https://palegis.us.evil.example/legislation/bills/2025/hb1',
    ),
  ).toBeUndefined();
});

test.each([
  'https://www.legis.state.pa.us/cfdocs/legis/PN/Public/btCheck.cfm?txtType=PDF&sessYr=2025&sessInd=0&billBody=H&billTyp=B&billNbr=2443&pn=abc',
  'https://www.legis.state.pa.us/cfdocs/legis/PN/Public/btCheck.cfm?txtType=PDF&sessYr=2025&sessInd=0&billBody=H&billTyp=B&billNbr=2443&pn=-1',
  'https://www.legis.state.pa.us/cfdocs/legis/PN/Public/btCheck.cfm?txtType=PDF&sessYr=2025&sessInd=0&billBody=H&billTyp=B&billNbr=2443&pn=0',
  'https://www.legis.state.pa.us/WU01/LI/BI/BT/2025/0/HB2443P0000.pdf',
])(
  'malformed printer number in %s is refused, not replaced by the newest',
  (input) => {
    expect(() => resolvePennsylvania(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  },
);

test.each([
  'http://www.palegis.us/legislation/bills/2025/hb2443',
  'https://www.palegis.us:8443/legislation/bills/2025/hb2443',
  'https://user@www.palegis.us/legislation/bills/2025/hb2443',
  'https://www.palegis.us/legislation/bills/2025/hb2443%2f..',
  // Fiscal notes and memos carry no change marks.
  'https://www.palegis.us/WU01/LI/BI/FN/2025/0/HB2443P4082.pdf',
  'https://www.legis.state.pa.us/WU01/LI/BI/FN/2025/0/HB2443P4082.pdf',
  // Not bill or resolution types the site publishes.
  'https://www.palegis.us/legislation/bills/2025/hjr1',
  'https://www.palegis.us/legislation/bills/2025/hb0',
  'https://www.palegis.us/legislation/bills/1900/hb1',
  'https://www.palegis.us/legislation/bills/2025/4/hb1',
  'https://www.palegis.us/legislation/amendments/amendment-list?billnum=2443',
  'https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB2443/PN0',
  'https://www.palegis.us/legislation/bills/text/PDF/2025/0/XX2443/PN4082',
  'https://www.palegis.us/senate/members',
  'https://www.legis.state.pa.us/cfdocs/billinfo/billinfo.cfm?syear=2025&sind=0&body=X&type=B&bn=1',
  'https://www.legis.state.pa.us/cfdocs/other.cfm',
])('refuses %s before any fetch', (input) => {
  expect(() => resolvePennsylvania(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});

const lookup = { year: 2025, session: 0, type: 'HB', number: 2443 } as const;
const link = (bill: string, pn: string, year = 2025, session = 0) =>
  `<a href='/legislation/bills/text/PDF/${String(year)}/${String(session)}/${bill}/PN${pn}' target='_blank'>${pn}</a>`;

test('the newest printer number on the page is chosen, whatever the order', () => {
  const html = [
    link('HB2443', '3253'),
    link('HB2443', '4082'),
    link('HB2443', '3616'),
    link('HB2443', '4082'),
  ].join('\n');
  expect(choosePennsylvaniaText(html, lookup)).toBe(
    text(2025, 0, 'HB2443', '4082'),
  );
});

test('links of other bills, sessions and years never win', () => {
  const html = [
    link('HB2443', '3253'),
    link('HB2442', '9999'),
    link('SB2443', '9999'),
    link('HB2443', '9999', 2023),
    link('HB2443', '9999', 2025, 1),
  ].join('\n');
  expect(choosePennsylvaniaText(html, lookup)).toBe(
    text(2025, 0, 'HB2443', '3253'),
  );
});

test('a page with no printer number says the bill has no text yet', () => {
  expect(() =>
    choosePennsylvaniaText('<html>Page Not Found</html>', lookup),
  ).toThrow(
    expect.objectContaining({
      code: 'INVALID_INPUT',
      userMessage: expect.stringContaining('no published bill text') as string,
    }),
  );
});

test.each([
  'https://www.palegis.us/legislation/bills/2025/hb2443',
  'https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB2443/PN4082',
  'https://palegis.us/legislation/bills/text/PDF/2025/0/SR0374/PN1942',
])('fetch of %s is allowed', (url) => {
  expect(() => {
    assertPennsylvaniaFetch(new URL(url));
  }).not.toThrow();
});

test.each([
  'http://www.palegis.us/legislation/bills/2025/hb2443',
  'https://www.palegis.us:444/legislation/bills/2025/hb2443',
  'https://www.palegis.us/legislation/bills/text/HTM/2025/0/HB2443/PN4082',
  'https://www.palegis.us/legislation/bills/text/PDF/2025/0/HB2443/4082',
  'https://www.palegis.us/senate/members',
  'https://www.legis.state.pa.us/cfdocs/billinfo/billinfo.cfm',
  'https://evil.example/legislation/bills/2025/hb2443',
])('fetch of %s is blocked', (url) => {
  expect(() => {
    assertPennsylvaniaFetch(new URL(url));
  }).toThrow(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
});

test('/404 is allowed only for the bill-page lookup, never for the PDF text fetch', () => {
  const missing = new URL('https://www.palegis.us/404');
  expect(() => {
    assertPennsylvaniaFetch(missing, true);
  }).not.toThrow();
  expect(() => {
    assertPennsylvaniaFetch(missing);
  }).toThrow(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
});
