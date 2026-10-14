import { expect, test, vi } from 'vitest';
import {
  makeOhioActionsJson,
  makeOhioAmendmentsJson,
  makeOhioHistoryJson,
  makeOhioVersionsJson,
} from '../../../tests/synth/ohio-history.js';
import { documentId, type SafeFetchResult } from '../fetch/index.js';
import { AppError, BillHistory } from '../model/index.js';
import { assertHistoryUrl } from './allowlist.js';
import { chooseVersion, historySource, resolveHistory } from './resolve.js';
import {
  chooseOhioVersion,
  isOhioLandingHost,
  ohioHistorySource,
  ohioTextUrl,
  parseOhioHistory,
  partyLabel,
  plainText,
  resolveOhio,
} from './ohio-legislature.js';

const landing = 'https://www.legislature.ohio.gov/legislation/135/hb9001';
const plan = resolveOhio(new URL(landing))!;
const fetchedAt = '2026-10-14T00:00:00.000Z';
const encode = (value: unknown) =>
  new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  );
const parse = (overrides: Partial<Record<string, unknown>> = {}) => {
  const json = { ...makeOhioHistoryJson(), ...overrides };
  return parseOhioHistory(
    {
      versions: encode(json.versions),
      actions: encode(json.actions),
      meetings: encode(json.meetings),
      amendments: encode(json.amendments),
    },
    plan,
    fetchedAt,
  );
};

test.each(['', '/', '/status', '/documents/', '/committee?x=1#top'])(
  'Ohio landing mapping accepts bill page suffix %s',
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
  expect(historySource('ohio').textUrl(plan, '06_EN')).toBe(
    ohioTextUrl(plan, '06_EN'),
  );
  expect(historySource('ohio').isVersion('06_EN')).toBe(true);
  expect(historySource('ohio').isVersion('../00_IN')).toBe(false);
  expect(() => ohioTextUrl(plan, '../00_IN')).toThrow(AppError);
});
test.each([
  // Not on the landing host:

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
  // Unmapped URLs on the landing host are rejected with guidance, never fetched.
  if (isOhioLandingHost(new URL(url)))
    expect(() => resolveHistory(url)).toThrow(AppError);
  else expect(resolveHistory(url)).toBeUndefined();
});
test('raw dot segments and backslashes do not normalize into a supported Ohio URL', () => {
  expect(() =>
    resolveHistory(
      'https://www.legislature.ohio.gov/legislation/135/hb9001/../hb9002',
    ),
  ).toThrow(AppError);
  expect(() =>
    resolveHistory('https://www.legislature.ohio.gov/legislation/135\\hb9001'),
  ).toThrow(AppError);
});

test('orders the seven versions by stage, with labels, and builds text URLs from identity', () => {
  const versions = makeOhioVersionsJson().reverse();
  const { history } = parse({ versions: JSON.stringify(versions) });
  expect(BillHistory.safeParse(history).success).toBe(true);
  expect(history.versions.map((v) => v.code)).toEqual([
    '00_IN',
    '01_RH',
    '02_PH',
    '03_RS',
    '04_PS',
    '05_CR',
    '06_EN',
  ]);
  expect(history.versions[1]!.label).toBe(
    'As Reported by the House Finance Committee',
  );
  expect(history.versions[6]!.url).toBe(ohioTextUrl(plan, '06_EN'));
  expect(chooseOhioVersion(history)).toBe('06_EN');
  expect(chooseVersion(plan, history)).toBe('06_EN');
  expect(history.officialSummary).toBeUndefined();
});
test('sources list exactly the four LIS endpoints', () => {
  const { history } = parse();
  expect(history.sources.map((s) => [s.host, s.url])).toEqual(
    ['', 'actions/', 'meetings/', 'amendments/'].map((p) => [
      'search-prod.lis.state.oh.us',
      `https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/${p}`,
    ]),
  );
});
test('actions combine the record, meetings (not canceled) and signing dates, oldest first', () => {
  const { history } = parse();
  expect(history.actions.map((a) => [a.date, a.text])).toEqual([
    ['2024-02-16', 'Introduced'],
    ['2024-03-04', 'On the Finance meeting agenda'],
    ['2024-04-26', 'Passed'],
    ['2024-05-03', 'Refer to Committee'],
    ['2024-06-15', 'Passed'],
    ['2024-06-30', 'Conference report agreed to'],
    ['2024-07-03', 'Signed by the Governor'],
    ['2024-07-04', 'Effective date'],
  ]);
  expect(history.actions[1]).toMatchObject({
    chamber: 'House',
    committee: 'Finance',
  });
  expect(history.actions[3]).toMatchObject({ committee: 'Finance' });
  expect(history.actions[0]!.committee).toBeUndefined();
});
test('an empty amendments list gives no amendments', () => {
  expect(parse().history.amendments).toEqual([]);
});
test('amendments keep their number and constructed URL, and name the sponsor the record states', () => {
  const { history } = parse({
    amendments: JSON.stringify(makeOhioAmendmentsJson()),
  });
  expect(history.amendments).toEqual([
    {
      id: 'am0168',
      number: 'am0168',
      status: 'unknown',
      sponsor: { name: 'Alex Example', memberId: '1001' },
      description: 'Amendment am0168 (As Introduced)',
      url: 'https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/amendments/am0168/pdf/',
    },
  ]);
});
test('maps sponsors and cosponsors with party labels and member ids, with no invented links', () => {
  const { sponsorProfiles } = parse();
  expect(sponsorProfiles).toEqual([
    {
      name: 'Alex Example',
      role: 'sponsor',
      party: 'Republican',
      district: '42',
      chamber: 'house',
      memberId: '1001',
      links: [],
    },
    expect.objectContaining({
      name: 'Sam Sample',
      role: 'cosponsor',
      party: 'Democrat',
      chamber: 'senate',
      memberId: '1002',
      links: [],
    }),
    expect.objectContaining({ party: 'Independent' }),
    expect.objectContaining({ name: 'Kit Unknown', party: undefined }),
  ]);
});
test('partyLabel only maps recognised codes', () => {
  expect(partyLabel('party_democrat_1')).toBe('Democrat');
  expect(partyLabel('party_green_1')).toBeUndefined();
  expect(partyLabel(undefined)).toBeUndefined();
  expect(partyLabel('Democrat')).toBeUndefined();
});
test('hostile text is stripped to plain text and never becomes a URL', () => {
  const versions = makeOhioVersionsJson({
    version: 'As <b onmouseover="x()">Introduced</b><script>alert(1)</script>',
    sponsors: [
      {
        full_name:
          '<img src=x onerror=alert(1)>Alex &lt;script&gt;Evil&lt;/script&gt;',
        member_id: 5,
        party: 'party_democrat_1',
        chamber: 'House',
      },
    ],
    cosponsors: [],
  });
  const actions = [
    ...makeOhioActionsJson(),
    {
      occurred: '2024-07-01',
      action: 'Passed <a href="https://evil.test">click</a>\u0000',
    },
  ];
  const { history, sponsorProfiles } = parse({
    versions: JSON.stringify(versions),
    actions: JSON.stringify(actions),
  });
  expect(history.versions[0]!.label).toBe('As Introduced alert(1)');
  expect(history.actions.at(-3)!.text).toBe('Passed click');
  expect(sponsorProfiles[0]!.name).toBe('Alex Evil');
  expect(JSON.stringify([history, sponsorProfiles])).not.toMatch(
    /[<>]|evil\.test/,
  );
});
test.each([
  ['an unterminated tag', 'a <b', 'a'],
  [
    'entity-encoded markup',
    '&lt;i&gt;x&lt;/i&gt; &amp; &#60;b&#62;y&#x3c;/b&#x3e;',
    'x & y',
  ],
  [
    'unknown entities and bad code points',
    '&bogus; &#0; &#9999999;',
    '&bogus; &#9999999;',
  ],
  ['style blocks (content is plain text)', 'k<style>p{}</style>l', 'k p{} l'],
  ['bare angle brackets', '1 < 2 > 0', '1 0'],
])('plainText handles %s', (_name, input, expected) => {
  expect(plainText(input)).toBe(expected);
});
test.each([
  ['not JSON', 'nope'],
  ['an object instead of a list', '{}'],
  ['an empty version list', '[]'],
  ['a version without a code', JSON.stringify([{ version: 'x' }])],
  [
    'a bad version id',
    JSON.stringify(makeOhioVersionsJson({ version_id: '../' })),
  ],
  ['another bill', JSON.stringify(makeOhioVersionsJson({ number: 'hb1' }))],
])('fails closed on %s', (_name, versions) => {
  expect(() => parse({ versions })).toThrow(
    expect.objectContaining({ code: 'PARSE_FAILED' }) as unknown,
  );
});
test('latest version fails clearly when none is known', () => {
  expect(() => chooseOhioVersion()).toThrow(
    expect.objectContaining({ code: 'FETCH_FAILED' }) as unknown,
  );
});

test('only the LIS API host may be fetched; the landing host and member hosts may not', () => {
  assertHistoryUrl('ohio', ohioTextUrl(plan, '00_IN'));
  for (const url of [
    landing,
    `${landing}/status`,
    'https://ohiohouse.gov/members/alex-example',
    'https://search-prod.lis.state.oh.us.evil.test/api/v2/',
    'http://search-prod.lis.state.oh.us/api/v2/',
  ])
    expect(() => {
      assertHistoryUrl('ohio', url);
    }).toThrow(AppError);
});
test('reading history fetches the four API endpoints and never www.legislature.ohio.gov', async () => {
  const json = makeOhioHistoryJson();
  const body: Record<string, string> = {
    '': json.versions,
    'actions/': json.actions,
    'meetings/': json.meetings,
    'amendments/': json.amendments,
  };
  const base =
    'https://search-prod.lis.state.oh.us/api/v2/general_assembly_135/legislation/hb9001/';
  const fetcher = vi.fn((url: string): Promise<SafeFetchResult> => {
    const bytes = encode(body[url.slice(base.length)] ?? 'x');
    return Promise.resolve({
      bytes,
      docId: documentId(bytes),
      finalUrl: url,
      contentType: 'application/json',
      format: 'unknown',
      fromCache: false,
    });
  });
  const record = await ohioHistorySource.read(
    plan,
    fetcher,
    () => new Date(fetchedAt),
  );
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual(
    ['', 'actions/', 'meetings/', 'amendments/'].map((p) => `${base}${p}`),
  );
  for (const [url] of fetcher.mock.calls)
    expect(new URL(url).hostname).not.toBe('www.legislature.ohio.gov');
  expect(record.history.versions).toHaveLength(7);
  expect(record.sponsorProfiles).toHaveLength(4);
});
test('several amendment sponsors: the first is the sponsor, the rest go in the description; none gives no sponsor', () => {
  const [first] = makeOhioAmendmentsJson().flatMap(
    (a) => (a as { sponsors: unknown[] }).sponsors,
  );
  const extra = {
    ...(first as object),
    full_name: 'Robin Second',
    member_id: 7,
  };
  const amendment = (sponsors: unknown[]) =>
    JSON.stringify([
      { amendment_number: 'am1', version: 'As Introduced', sponsors },
    ]);
  const both = parse({ amendments: amendment([first, extra]) });
  expect(both.history.amendments[0]).toMatchObject({
    sponsor: { name: 'Alex Example', memberId: '1001' },
    description:
      'Amendment am1 (As Introduced). Also sponsored by Robin Second',
  });
  const none = parse({ amendments: amendment([]) }).history.amendments[0]!;
  expect(none.sponsor).toBeUndefined();
  const noId = parse({
    amendments: amendment([{ full_name: 'No Id' }]),
  }).history.amendments[0]!;
  expect(noId.sponsor).toEqual({ name: 'No Id' });
});

test('a 1 MB hostile string is sanitized in linear time and capped', () => {
  for (const hostile of [
    '<script '.repeat(130_000),
    '<script>'.repeat(130_000),
  ]) {
    const started = performance.now();
    const out = plainText(hostile);
    expect(performance.now() - started).toBeLessThan(100);
    expect(out.length).toBeLessThanOrEqual(2_001);
    expect(out).not.toMatch(/[<>]/);
  }
  const long = plainText('word '.repeat(10_000));
  expect(long.length).toBeLessThanOrEqual(2_001);
  expect(long.endsWith('…')).toBe(true);
});
test('zero-width and bidi characters are stripped from text fields', () => {
  expect(plainText('a​b‎c‮d⁦e⁩f﻿g')).toBe('abcdefg');
  const names = parse({
    versions: JSON.stringify(
      makeOhioVersionsJson({
        sponsors: [{ full_name: 'Alex‮ Example'.padEnd(500, 'x') }],
        cosponsors: [],
      }),
    ),
  }).sponsorProfiles;
  expect(names[0]!.name).not.toContain('‮');
  expect(names[0]!.name.length).toBeLessThanOrEqual(201);
});
test('missing or malformed optional parts keep the history and mark it partial', () => {
  const json = makeOhioHistoryJson();
  const bytes = (v: string) => new TextEncoder().encode(v);
  const record = parseOhioHistory(
    {
      versions: bytes(json.versions),
      actions: undefined,
      meetings: bytes('[{"committee":"x"}]'),
      amendments: bytes(json.amendments),
    },
    plan,
    fetchedAt,
  );
  expect(record.partial).toBe(true);
  expect(record.history.versions).toHaveLength(7);
  expect(record.history.actions.map((a) => a.text)).toEqual([
    'Signed by the Governor',
    'Effective date',
  ]);
  expect(record.history.sources.map((s) => s.url.split('/').at(-2))).toEqual([
    'hb9001',
    'amendments',
  ]);
  expect(parse().partial).toBeUndefined();
});
test.each([
  'https://www.legislature.ohio.gov./legislation/135/hb9001',
  `${landing}/text`,
  'http://www.legislature.ohio.gov/legislation/135/hb9001',
  'https://www.legislature.ohio.gov/',
  'https://legislature.ohio.gov/legislation/135/hb9001',
])('rejects the unmapped legislature URL %s before any fetch', (url) => {
  expect(() => resolveHistory(url)).toThrow(
    expect.objectContaining({
      code: 'INVALID_INPUT',
      userMessage: expect.stringContaining('legislation/135/hb9001') as unknown,
    }) as unknown,
  );
});
