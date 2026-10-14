import { expect, test } from 'vitest';
import { makeOhioHistoryPages } from '../../../tests/synth/ohio-history.js';
import { AppError, BillHistory, SponsorProfile } from '../model/index.js';
import { assertHistoryUrl } from './allowlist.js';
import { chooseVersion, historySource, resolveHistory } from './resolve.js';
import {
  chooseOhioVersion,
  ohioTextUrl,
  parseOhioHistory,
  resolveOhio,
} from './ohio-legislature.js';

const landing = 'https://www.legislature.ohio.gov/legislation/135/hb9001';
const plan = resolveOhio(new URL(landing))!;
const fetchedAt = '2026-10-14T00:00:00.000Z';
const parse = (pages = makeOhioHistoryPages()) =>
  parseOhioHistory(pages, plan, fetchedAt);

test.each(['', '/', '/status', '/documents/', '/committee?x=1#top'])(
  'Ohio mapping accepts bill page suffix %s',
  (suffix) => {
    expect(resolveHistory(`${landing}${suffix}`)).toEqual(plan);
  },
);
test.each(['hb', 'sb', 'hjr', 'sjr', 'hcr', 'scr', 'hr', 'sr'])(
  'maps Ohio bill type %s',
  (type) => {
    expect(
      resolveHistory(landing.replace('hb9001', `${type}9001`)),
    ).toMatchObject({ bill: `${type}9001` });
  },
);
test('the LIS URL version wins and the registry constructs text URLs', () => {
  const url = ohioTextUrl(plan, '00_IN');
  const explicit = resolveHistory(`${url}?x=1#pdf`)!;
  expect(explicit).toMatchObject({ ...plan, version: '00_IN', textUrl: url });
  expect(chooseVersion(explicit, parse().history)).toBe('00_IN');
  expect(chooseVersion(explicit)).toBe('00_IN');
  expect(historySource('ohio').textUrl(plan, '06_EN')).toBe(
    ohioTextUrl(plan, '06_EN'),
  );
  expect(historySource('ohio').isVersion('06_EN')).toBe(true);
  expect(historySource('ohio').isVersion('../00_IN')).toBe(false);
  expect(() => ohioTextUrl(plan, '../00_IN')).toThrow(AppError);
});
test.each([
  landing.replace('https:', 'http:'),
  landing.replace('www.', 'user@www.'),
  landing.replace('.gov/', '.gov:444/'),
  landing.replace('www.', ''),
  landing.replace('.gov/', '.gov.evil.test/'),
  landing.replace('/135/', '/0135/'),
  landing.replace('hb9001', 'hb0'),
  `${landing}/votes`,
  `${landing}/documents/extra`,
  landing.replace('hb9001', 'hb%39'),
  ohioTextUrl(plan, '00_IN').replace('00_IN', '00_in'),
  ohioTextUrl(plan, '00_IN').replace('pdf/', 'xml/'),
  ohioTextUrl(plan, '00_IN').replace('search-prod.', 'evil.search-prod.'),
])('does not map malformed or unmatched Ohio URL %s', (url) => {
  expect(resolveHistory(url)).toBeUndefined();
});

test('parses all substitute versions in listed order, dates by stage, status and committee actions', () => {
  const { history, sponsorProfiles } = parse();
  expect(BillHistory.safeParse(history).success).toBe(true);
  expect(history.versions.map((v) => [v.code, v.date])).toEqual([
    ['06_EN', '2024-06-06'],
    ['05_CR', '2024-06-05'],
    ['04_PS', '2024-06-04'],
    ['03_RS', '2024-06-03'],
    ['02_PH', '2024-05-02'],
    ['01_RH', '2024-05-02'],
    ['00_IN', '2024-02-01'],
  ]);
  expect(history.versions[0]!.label).toBe('As Enrolled');
  expect(history.actions).toHaveLength(10);
  expect(history.actions.at(-1)).toEqual({
    date: '2024-03-04',
    chamber: 'House',
    committee: 'Example Finance',
    text: '1st Hearing',
    url: `${landing}/committee`,
  });
  expect(history.sources).toEqual(
    ['status', 'documents', 'committee'].map((kind) => ({
      host: 'www.legislature.ohio.gov',
      url: `${landing}/${kind}`,
      fetchedAt,
    })),
  );
  expect(history.officialSummary).toBeUndefined();
  expect(
    sponsorProfiles.every((p) => SponsorProfile.safeParse(p).success),
  ).toBe(true);
  expect(sponsorProfiles[0]).toMatchObject({
    name: 'Alex Example',
    role: 'sponsor',
    memberId: 'alex-example',
    chamber: 'house',
    links: [
      {
        kind: 'legislature',
        verified: true,
        url: 'https://ohiohouse.gov/members/alex-example',
      },
    ],
  });
  expect(sponsorProfiles[1]).toMatchObject({
    name: 'Archived Example',
    role: 'sponsor',
    links: [],
  });
  expect(sponsorProfiles[1]!.memberId).toBeUndefined();
  expect(sponsorProfiles[2]).toMatchObject({
    name: 'Sam Sample',
    role: 'cosponsor',
    memberId: 'sam-sample',
    chamber: 'senate',
  });
  expect(sponsorProfiles[3]).toMatchObject({
    name: 'Archived Senator',
    role: 'cosponsor',
    links: [],
    chamber: 'senate',
  });
});
test('amendment synopsis has its own label and URL without inferred attribution; comparisons are omitted', () => {
  expect(parse().history.amendments).toEqual([
    {
      id: 'download-key-701',
      status: 'unknown',
      description: 'Synopsis of Committee Amendments',
      url: 'https://www.legislature.ohio.gov//download?key=701',
    },
  ]);
});
test('only explicit adoption, date and committee are attached to an amendment', () => {
  const pages = makeOhioHistoryPages();
  pages.documents = pages.documents
    .replace('Synopsis of Committee Amendments', 'Amendment adopted')
    .replace(
      '</a></li>\n        <li>',
      '</a><time datetime="2024-05-02"></time><span class="committee-cell">Example Rules</span></li>\n        <li>',
    );
  expect(parse(pages).history.amendments[0]).toMatchObject({
    status: 'adopted',
    date: '2024-05-02',
    committee: 'Example Rules',
  });
  pages.documents = pages.documents.replace(
    'Amendment adopted',
    'Amendment not adopted',
  );
  expect(parse(pages).history.amendments[0]!.status).toBe('unknown');
});
test('latest version uses numbered stages even when dates are missing or equal', () => {
  const history = parse().history;
  expect(chooseVersion(plan, history)).toBe('06_EN');
  history.versions.forEach((v) => {
    delete v.date;
  });
  history.versions.reverse();
  expect(chooseOhioVersion(history)).toBe('06_EN');
  for (const bad of [
    undefined,
    { ...history, versions: [] },
    { ...history, versions: [{ code: '../EN', label: 'Bad' }] },
  ]) {
    expect(() => chooseOhioVersion(bad)).toThrow(AppError);
  }
  try {
    chooseOhioVersion();
  } catch (error) {
    expect((error as AppError).userMessage).toContain('specific version URL');
  }
});
test('missing stage dates stay absent; document dates take precedence and repeated formats deduplicate', () => {
  const pages = makeOhioHistoryPages();
  pages.status = pages.status.replace(
    'Sent To The Governor',
    'Signed By The Governor',
  );
  expect(parse(pages).history.versions[0]!.date).toBeUndefined();
  pages.documents = pages.documents.replace(
    '</a></li>',
    '</a><time datetime="2024-06-07"></time></li>',
  );
  const textLink = /<li><a href="https:\/\/search-prod[^]*?<\/li>/.exec(
    pages.documents,
  )![0];
  pages.documents = pages.documents.replace(textLink, textLink + textLink);
  const history = parse(pages).history;
  expect(history.versions[0]!.date).toBe('2024-06-07');
  expect(history.versions).toHaveLength(7);
});
test('committee page may have no meetings; testimony never supplies amendments or sponsors', () => {
  const pages = makeOhioHistoryPages();
  pages.committee = pages.committee.replace(
    /<table class="committee-meeting-table">[^]*?<\/table>/,
    '',
  );
  expect(parse(pages).history.actions).toHaveLength(9);
  expect(parse(pages).sponsorProfiles).toHaveLength(4);
});
test.each(['status', 'documents', 'committee'] as const)(
  'rejects a missing, wrong-bill or wrong-session %s page',
  (kind) => {
    for (const invalid of [
      '',
      '<html><h1>Access denied</h1></html>',
      makeOhioHistoryPages()[kind].replace(/hb9001/g, 'hb9002'),
      makeOhioHistoryPages()[kind].replace(/\/135\//g, '/136/'),
    ]) {
      expect(() =>
        parse({ ...makeOhioHistoryPages(), [kind]: invalid }),
      ).toThrow(AppError);
    }
  },
);
test.each(['2-30-2024', '0-2-2024', '2-0-2024', 'garbage'])(
  'rejects invalid status date %s rather than normalize it',
  (value) => {
    const pages = makeOhioHistoryPages();
    pages.status = pages.status.replace('2-1-2024', value);
    expect(() => parse(pages)).toThrow(AppError);
  },
);
test.each([
  'https://evil.test/bill.pdf',
  'https://www.legislature.ohio.gov/download?key=5',
  'https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9002/06_EN/pdf/',
  'https://search-prod.lis.state.oh.us/api/v2/general_assembly_136/legislation/hb9001/06_EN/pdf/',
  'https://[bad',
])('never selects an older text when latest link is unusable: %s', (url) => {
  const pages = makeOhioHistoryPages();
  pages.documents = pages.documents.replace(ohioTextUrl(plan, '06_EN'), url);
  expect(() => parse(pages)).toThrow(AppError);
});
test.each([
  'http://ohiohouse.gov/members/alex-example',
  'https://ohiohouse.gov.evil.test/members/alex-example',
  'https://user@ohiohouse.gov/members/alex-example',
  'https://ohiohouse.gov:444/members/alex-example',
  'https://[bad',
])('untrusted member link retains only the name: %s', (url) => {
  const pages = makeOhioHistoryPages();
  pages.status = pages.status.replace(
    'https://ohiohouse.gov/members/alex-example',
    url,
  );
  expect(parse(pages).sponsorProfiles[0]).toMatchObject({
    name: 'Alex Example',
    links: [],
  });
  expect(parse(pages).sponsorProfiles[0]!.memberId).toBeUndefined();
});
test('only exact Ohio history hosts may be fetched; member hosts are links only', () => {
  for (const host of [
    'www.legislature.ohio.gov',
    'search-prod.lis.state.oh.us',
  ])
    expect(() => {
      assertHistoryUrl('ohio', `https://${host}/`);
    }).not.toThrow();
  for (const host of [
    'legislature.ohio.gov',
    'www.legislature.ohio.gov.evil.test',
    'search-prod.lis.state.oh.us.evil.test',
    'ohiohouse.gov',
    'www.ohiosenate.gov',
  ])
    expect(() => {
      assertHistoryUrl('ohio', `https://${host}/`);
    }).toThrow(AppError);
});

test('blank committee statuses record the meeting without inventing a numbered hearing', () => {
  const pages = makeOhioHistoryPages();
  pages.committee = pages.committee.replace('1st Hearing', '');
  expect(parse(pages).history.actions.at(-1)).toMatchObject({
    text: 'Committee meeting',
    date: '2024-03-04',
    committee: 'Example Finance',
    chamber: 'House',
  });
  pages.committee = pages.committee.replace(
    'House Committees',
    'Senate Committees',
  );
  expect(parse(pages).history.actions.at(-1)!.chamber).toBe('Senate');
  pages.committee = pages.committee.replace(
    'Senate Committees',
    'Other Committees',
  );
  expect(parse(pages).history.actions.at(-1)!.chamber).toBeUndefined();
});
test('raw dot segments and backslashes do not normalize into a supported Ohio URL', () => {
  for (const url of [
    `${landing}/../hb9001`,
    landing.replace('/legislation/', '/legislation\\'),
    `${landing}/documents/../status`,
  ])
    expect(resolveHistory(url)).toBeUndefined();
});
test('missing parser landmarks, action text or versions fail closed', () => {
  for (const [kind, before, after] of [
    ['status', 'legislation-status-table', 'unrecognized'],
    ['documents', 'Legislation Text', 'Other Text'],
    [
      'documents',
      /<section class="legislation-section"><h2>Legislation Text<\/h2>[^]*?<\/section>/,
      '<section class="legislation-section"><h2>Legislation Text</h2></section>',
    ],
    ['committee', /<h2[^]*?<\/h2><h2>House Committees<\/h2>/, ''],
    ['status', 'Sent To The Governor', ''],
  ] as const) {
    const pages = makeOhioHistoryPages();
    pages[kind] = pages[kind].replace(before, after);
    expect(() => parse(pages)).toThrow(AppError);
  }
});
