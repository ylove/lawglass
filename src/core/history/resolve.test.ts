import { expect, test } from 'vitest';
import { AppError, type BillHistory } from '../model/index.js';
import { makeBillStatusXml } from '../../../tests/synth/billstatus.js';
import { parseGovinfoBillStatus } from './govinfo-billstatus.js';
import {
  assertNoCongressFetch,
  chooseVersion,
  govinfoTextUrl,
  historySource,
  resolveGovinfo,
  resolveHistory,
} from './resolve.js';

const page = 'https://www.congress.gov/bill/118th-congress/house-bill/9001';
test('fetch policy rejects Congress.gov itself even when a redirect names a valid bill URL', () => {
  expect(() => {
    assertNoCongressFetch(new URL(page));
  }).toThrow(AppError);
  expect(() => {
    assertNoCongressFetch(new URL('https://other.gov/bill'));
  }).not.toThrow();
});
test.each([
  ['house-bill', 'hr'],
  ['senate-bill', 's'],
  ['house-joint-resolution', 'hjres'],
  ['senate-joint-resolution', 'sjres'],
  ['house-concurrent-resolution', 'hconres'],
  ['senate-concurrent-resolution', 'sconres'],
  ['house-resolution', 'hres'],
  ['senate-resolution', 'sres'],
])('maps %s into an anchored GovInfo plan', (slug, type) => {
  expect(resolveHistory(page.replace('house-bill', slug))).toEqual({
    source: 'govinfo',
    congress: 118,
    type,
    number: 9001,
    billStatusUrl: `https://www.govinfo.gov/bulkdata/BILLSTATUS/118/${type}/BILLSTATUS-118${type}9001.xml`,
  });
});

test.each([
  `${page}/text/ih`,
  `${page}/text/ih/?x=1#text`,
  'https://congress.gov/bill/118th-congress/house-bill/9001/text/ih',
  'https://www.govinfo.gov/app/details/BILLS-118hr9001ih',
  'https://govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml',
  'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/pdf/BILLS-118hr9001ih.pdf',
  'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/html/BILLS-118hr9001ih.htm',
])('retains the version from %s', (url) => {
  expect(resolveHistory(url)).toMatchObject({
    version: 'ih',
    textUrl:
      'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml',
  });
});

test('BILLSTATUS and /text landing URLs require a version from the record', () => {
  expect(resolveHistory(`${page}/text/`)).not.toHaveProperty('version');
  expect(
    resolveHistory(
      'https://www.govinfo.gov/bulkdata/BILLSTATUS/118/hr/BILLSTATUS-118hr9001.xml',
    ),
  ).toEqual(resolveHistory(page));
});

test.each([
  'https://www.congress.gov/help',
  'https://www.congress.gov./help',
  'https://api.congress.gov/help',
  `${page}/all-info`,
  `${page}/text/ih/extra`,
  `${page}/text/%69h`,
  page.replace('house-bill', 'house-amendment'),
  page.replace('/9001', '/0'),
  page.replace('https:', 'http:'),
  page.replace('www.', 'user@www.'),
  page.replace('.gov/', '.gov:444/'),
  `${page}/../9001`,
  page.replace('/bill/', '/bill\\'),
  `${page}/text/../../help`,
])('rejects unmatched congress.gov inputs before fetching: %s', (url) => {
  expect(() => resolveHistory(url)).toThrow(AppError);
  try {
    resolveHistory(url);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('INVALID_INPUT');
    expect((error as AppError).userMessage).toContain(
      'Paste a congress.gov bill URL',
    );
  }
});

test.each([
  'not a url',
  'https://other.gov/bill',
  'https://www.congress.gov.evil.test/help',
  'https://www.govinfo.gov/help',
  'http://www.govinfo.gov/app/details/BILLS-118hr9001ih',
  'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9002ih.xml',
  'https://www.govinfo.gov/app/details/BILLS-118hr9001ih/extra',
  'https://www.govinfo.gov/app/details/BILLS-118hr9001%69h',
  'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-118hr9001.xml',
  'https://www.govinfo.gov/content/pkg/not-a-bill/xml/not-a-bill.xml',
])('keeps other unmatched URLs on the existing path: %s', (url) => {
  expect(resolveHistory(url)).toBeUndefined();
});

test('explicit version wins; latest follows official list order even with missing or inconsistent dates', () => {
  const plan = resolveHistory(page)!;
  const history: BillHistory = {
    versions: [
      { code: 'enr', label: 'Enrolled', date: '2024-06-01' },
      { code: 'ih', label: 'Introduced', date: '2024-01-01' },
    ],
    actions: [],
    amendments: [],
    sources: [],
  };
  expect(chooseVersion(plan, history)).toBe('enr');
  expect(chooseVersion(resolveHistory(`${page}/text/ih`)!, history)).toBe('ih');
  expect(chooseVersion(resolveHistory(`${page}/text/ih`)!)).toBe('ih');
  for (const versions of [
    [
      { code: 'enr', label: 'Enrolled' },
      { code: 'eh', label: 'Engrossed', date: '2024-06-01' },
    ],
    [
      { code: 'enr', label: 'Enrolled', date: '2024-06-01' },
      { code: 'eh', label: 'Engrossed', date: '2024-06-02' },
    ],
    [
      { code: 'enr', label: 'Enrolled', date: '2024-06-01' },
      { code: 'eh', label: 'Engrossed', date: '2024-06-01' },
    ],
    [
      { code: 'enr', label: 'Enrolled', date: '2024-06-01' },
      { code: 'ih', label: 'Introduced' },
    ],
  ]) {
    expect(chooseVersion(plan, { ...history, versions })).toBe('enr');
  }
  expect(
    chooseVersion(plan, {
      ...history,
      versions: [{ code: 'ih', label: 'Introduced' }],
    }),
  ).toBe('ih');
  for (const versions of [
    [],
    [
      { code: '', label: 'Unavailable latest' },
      { code: 'eh', label: 'Engrossed', date: '2024-06-01' },
    ],
    [{ code: '../ih', label: 'Bad', date: '2024-01-01' }],
  ]) {
    expect(() => chooseVersion(plan, { ...history, versions })).toThrow(
      'The document could not be downloaded.',
    );
  }
  try {
    chooseVersion(plan);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).userMessage).toContain('specific version URL');
  }
});

test('hr5009 version-list shape chooses dateless Enrolled first, ahead of the later-dated Public Law', () => {
  const plan = resolveGovinfo(new URL(page))!;
  const { history } = parseGovinfoBillStatus(
    makeBillStatusXml(),
    plan,
    '2026-10-14T00:00:00.000Z',
  );
  expect(history.versions.map((item) => item.code)).toEqual([
    'enr',
    'eah',
    'eas',
    'pcs',
    'eh',
    'rh',
    'ih',
    '',
  ]);
  expect(history.versions[0]?.date).toBeUndefined();
  expect(history.versions.at(-1)?.date).toBe('2024-12-24T04:59:59Z');
  expect(chooseVersion(plan, history)).toBe('enr');
});

test('unknown sources and unsafe version codes fail closed', () => {
  expect(() => historySource('unknown')).toThrow(AppError);
  expect(historySource('govinfo').hosts).toEqual(['www.govinfo.gov']);
  expect(() => govinfoTextUrl(resolveGovinfo(new URL(page))!, '../ih')).toThrow(
    AppError,
  );
});
