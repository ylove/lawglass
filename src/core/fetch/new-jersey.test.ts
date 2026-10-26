import { expect, test } from 'vitest';
import {
  assertNewJerseyFetch,
  chooseNewJerseyText,
  newJerseyLookupUrl,
  resolveNewJersey,
} from './new-jersey.js';

const pdf = (year: number, folder: string, file: string) =>
  `https://pub.njleg.gov/Bills/${String(year)}/${folder}/${file}`;

test.each([
  ['https://www.njleg.state.nj.us/bill-search/2026/S1000', 2026, 'S1000'],
  ['https://njleg.state.nj.us/bill-search/2026/s01000/?utm=1#x', 2026, 'S1000'],
  ['https://www.njleg.gov/bill-search/2025/A3000', 2024, 'A3000'],
  [
    'https://www.njleg.state.nj.us/bill-search/2024/S1446/bill-text',
    2024,
    'S1446',
  ],
])('bill page %s asks for the newest text', (input, session, bill) => {
  expect(resolveNewJersey(input)).toEqual({ lookup: { session, bill } });
});

test.each([
  [
    'https://www.njleg.state.nj.us/bill-search/2024/S1446/bill-text?f=S1500&n=1446_R2',
    pdf(2024, 'S1500', '1446_R2.PDF'),
  ],
  [
    'https://pub.njleg.gov/Bills/2024/S1000/1000_R1.HTM',
    pdf(2024, 'S1000', '1000_R1.PDF'),
  ],
  [
    'https://pub.njleg.state.nj.us/Bills/2026/A3000/3000_I1.pdf',
    pdf(2026, 'A3000', '3000_I1.PDF'),
  ],
  [
    'https://pub.njleg.gov/bills/2024/S1500/1446_R2.HTM',
    pdf(2024, 'S1500', '1446_R2.PDF'),
  ],
  [
    'https://www.njleg.state.nj.us/2024/Bills/S1500/1446_R2.HTM',
    pdf(2024, 'S1500', '1446_R2.PDF'),
  ],
  [
    'https://www.njleg.state.nj.us/Bills/2026/S1000/1000_I1.HTM',
    pdf(2026, 'S1000', '1000_I1.PDF'),
  ],
])(
  'named version %s keeps that version, read from the PDF',
  (input, textUrl) => {
    expect(resolveNewJersey(input)).toEqual({ textUrl });
  },
);

test.each([
  'https://pub.njleg.gov/Bills/2024/S1000/1000_S1.HTM',
  // The folder's house letter must match the bill page's chamber.
  'https://www.njleg.state.nj.us/bill-search/2024/S1446/bill-text?f=A1500&n=1446_R2',
  'https://pub.njleg.gov/Bills/2024/S1000/1000_E1.PDF',
  'https://pub.njleg.gov/Bills/2024/S1000/1000_V1.PDF',
  'https://pub.njleg.gov/Bills/2022/AL23/75_.HTM',
  'https://www.njleg.state.nj.us/bill-search/2024/S1446/bill-text?f=S1500&n=1446_S1',
  'https://www.njleg.state.nj.us/bill-search/2024/S1446/bill-text?f=S1500&n=999_R1',
])('rejects non-bill-text NJ link %s', (input) => {
  expect(() => resolveNewJersey(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});

test.each([
  'http://www.njleg.state.nj.us/bill-search/2026/S1000',
  'https://www.njleg.state.nj.us:444/bill-search/2026/S1000',
  'https://user@www.njleg.state.nj.us/bill-search/2026/S1000',
  'https://www.njleg.state.nj.us/bill-search/2026/S0',
  'https://www.njleg.state.nj.us/bill-search/9999/S1000',
  'https://www.njleg.state.nj.us/bill-search/2026/SJR12',
  'https://www.njleg.state.nj.us/bill-search/2026/%53100',
  'https://www.njleg.state.nj.us/api/billDetail/billText/S1000/2026',
  'https://www.njleg.state.nj.us/bill-search/2026/S1000/../S2',
  'https://pub.njleg.gov/Bills/2024/S1000/1000_R1.HTM%2e',
  'https://pub.njleg.gov/other',
  // The bill-search shape is not a text-host path.
  'https://pub.njleg.gov/bill-search/2026/S1000',
])('rejects malformed or unsupported NJ URL %s', (input) => {
  expect(() => resolveNewJersey(input)).toThrow(
    expect.objectContaining({ code: 'INVALID_INPUT' }),
  );
});

test.each([
  'not a URL',
  'https://example.com/bill-search/2026/S1000',
  'https://njleg.gov.evil.test/bill-search/2026/S1000',
  'https://evilnjleg.gov/bill-search/2026/S1000',
  'https://pub.njleg.gov.evil.test/Bills/2024/S1000/1000_R1.PDF',
])('ignores non-NJ input %s', (input) => {
  expect(resolveNewJersey(input)).toBeUndefined();
});

const row = (description: string, file: string, folder = 'S1000') => ({
  Description: description,
  HTML_Link: `/Bills/2024/${folder}/${file}.HTM`,
  PDFLink: `/Bills/2024/${folder}/${file}.PDF`,
});
const lookup = { session: 2024, bill: 'S1000' };

test('chooses the newest introduced/reprint text, never statements or estimates', () => {
  const json = [
    row('Introduced', '1000_I1'),
    row('Statement', '1000_S1'),
    row('Reprint', '1000_R1'),
    row('Fiscal Estimate', '1000_E1'),
    row('Reprint', '1000_R2'),
    row('Fiscal Estimate', '1000_E2'),
    row('Statement', '1000_S3'),
    row('Veto', '1000_V1'),
    { Description: 'Pamphlet Law', HTML_Link: '/Bills/2024/PL24/23_.HTM' },
  ];
  expect(chooseNewJerseyText(json, lookup)).toBe(
    pdf(2024, 'S1000', '1000_R2.PDF'),
  );
  expect(chooseNewJerseyText([...json].reverse(), lookup)).toBe(
    pdf(2024, 'S1000', '1000_R2.PDF'),
  );
});

test('technical-review text ranks between introduced and reprints and a pasted _T1 link is bill text', () => {
  const rows = (...files: string[]) => files.map((f) => row('x', f));
  expect(chooseNewJerseyText(rows('1000_I1', '1000_T1'), lookup)).toBe(
    pdf(2024, 'S1000', '1000_T1.PDF'),
  );
  expect(
    chooseNewJerseyText(rows('1000_R1', '1000_T1', '1000_I1'), lookup),
  ).toBe(pdf(2024, 'S1000', '1000_R1.PDF'));
  expect(
    resolveNewJersey('https://pub.njleg.gov/Bills/2024/A3000/3000_T1.HTM'),
  ).toEqual({ textUrl: pdf(2024, 'A3000', '3000_T1.PDF') });
});

test('ignores a row whose folder belongs to the other house', () => {
  expect(() =>
    chooseNewJerseyText([row('Reprint', '1000_R5', 'A1500')], lookup),
  ).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
});

test('uses the JSON folder when it differs from the bill number', () => {
  expect(
    chooseNewJerseyText([row('Introduced', '100_I1', 'S0500')], {
      session: 2024,
      bill: 'S100',
    }),
  ).toBe(pdf(2024, 'S0500', '100_I1.PDF'));
});

test('falls back to the HTML link and refuses foreign links, sessions and bills', () => {
  expect(
    chooseNewJerseyText(
      [
        {
          Description: 'Introduced',
          HTML_Link: '/Bills/2024/S1000/1000_I1.HTM',
        },
      ],
      lookup,
    ),
  ).toBe(pdf(2024, 'S1000', '1000_I1.PDF'));
  for (const bad of [
    [],
    [{ PDFLink: 'https://evil.example/Bills/2024/S1000/1000_I1.PDF' }],
    [{ PDFLink: '/Bills/2022/S1000/1000_I1.PDF' }],
    [{ PDFLink: '/Bills/2024/S1000/999_I1.PDF' }],
    [{ PDFLink: '/Bills/2024/S1000/../../x/1000_I1.PDF' }],
  ])
    expect(() => chooseNewJerseyText(bad, lookup)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    );
  expect(() => chooseNewJerseyText({ message: 'nope' }, lookup)).toThrow(
    expect.objectContaining({ code: 'FETCH_FAILED' }),
  );
});

test('the lookup URL and fetch guard are exact', () => {
  const url = newJerseyLookupUrl(lookup);
  expect(url).toBe(
    'https://www.njleg.state.nj.us/api/billDetailHist/billText/S1000/2024',
  );
  expect(() => {
    assertNewJerseyFetch(new URL(url));
  }).not.toThrow();
  expect(() => {
    assertNewJerseyFetch(new URL(pdf(2024, 'S1500', '1446_R2.PDF')));
  }).not.toThrow();
  for (const bad of [
    'http://pub.njleg.gov/Bills/2024/S1000/1000_R1.PDF',
    'https://pub.njleg.gov:8443/Bills/2024/S1000/1000_R1.PDF',
    'https://u@pub.njleg.gov/Bills/2024/S1000/1000_R1.PDF',
    'https://pub.njleg.gov/x.pdf',
    'https://www.njleg.state.nj.us/bill-search/2024/S1000',
    'https://njleg.gov/api/billDetailHist/billText/S1000/2024',
    'https://www.njleg.state.nj.us/api/billDetailHist/billSponsors/S1000/2024',
    'https://evil.example/Bills/2024/S1000/1000_R1.PDF',
  ])
    expect(() => {
      assertNewJerseyFetch(new URL(bad));
    }).toThrow(expect.objectContaining({ code: 'SSRF_BLOCKED' }));
});
