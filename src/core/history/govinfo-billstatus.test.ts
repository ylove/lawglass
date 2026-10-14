import { expect, test } from 'vitest';
import {
  BILLSTATUS_XML,
  makeBillStatusXml,
} from '../../../tests/synth/billstatus.js';
import { BillHistory, SponsorProfile } from '../model/index.js';
import { parseGovinfoBillStatus } from './govinfo-billstatus.js';
import { resolveGovinfo } from './resolve.js';

const plan = resolveGovinfo(
  new URL('https://www.congress.gov/bill/118th-congress/house-bill/9001'),
)!;
const fetchedAt = '2026-10-14T00:00:00.000Z';
const parse = (xml: string) =>
  parseGovinfoBillStatus(new TextEncoder().encode(xml), plan, fetchedAt);

test('synthetic BILLSTATUS yields schema-valid history and sponsor profiles', () => {
  const { history, sponsorProfiles } = parseGovinfoBillStatus(
    makeBillStatusXml(),
    plan,
    fetchedAt,
  );
  expect(BillHistory.safeParse(history).success).toBe(true);
  expect(
    sponsorProfiles.every(
      (profile) => SponsorProfile.safeParse(profile).success,
    ),
  ).toBe(true);
  expect(sponsorProfiles).toEqual([
    {
      name: 'Rep. Example, Alex [I-OH-3]',
      role: 'sponsor',
      bioguideId: 'X000001',
      party: 'I',
      state: 'OH',
      district: '3',
      chamber: 'house',
      links: [],
    },
    {
      name: 'Jamie Q. Sample',
      role: 'cosponsor',
      bioguideId: 'X000002',
      party: 'I',
      state: 'ME',
      chamber: 'house',
      links: [],
    },
  ]);
  expect(history.officialSummary).toEqual({
    text: 'The bill creates example grants. It clarifies eligibility & limits.',
    source: 'Congressional Research Service',
    url: plan.billStatusUrl,
    date: '2024-06-10',
  });
  expect(history.versions.map((item) => item.code)).toEqual(['ih', 'eh']);
  expect(history.actions[0]).toMatchObject({
    text: 'Referred to the Example Committee.',
    committee: 'Example Committee',
    chamber: 'House',
  });
  expect(history.amendments[0]).toMatchObject({
    id: '118hamdt42',
    status: 'adopted',
    sponsor: { name: 'Rep. Sample, Jamie [I-ME]', bioguideId: 'X000002' },
    purpose: 'To clarify the example grant limit.',
  });
  expect(history.amendments[1]?.sponsor).toBeUndefined();
  expect(history.amendments[1]?.purpose).toBeUndefined();
  expect(history.sources).toEqual([
    { host: 'www.govinfo.gov', url: plan.billStatusUrl, fetchedAt },
  ]);
});

test('empty optional lists and older bill identity fields are supported', () => {
  const result = parse(
    '<billStatus><bill><congress>118</congress><billType>H</billType><billNumber>9001</billNumber></bill></billStatus>',
  );
  expect(result).toEqual({
    history: {
      versions: [],
      actions: [],
      amendments: [],
      sources: [
        { host: 'www.govinfo.gov', url: plan.billStatusUrl, fetchedAt },
      ],
    },
    sponsorProfiles: [],
  });
});

test.each([
  '',
  '<billStatus>',
  '<other/>',
  '<billStatus/>',
  BILLSTATUS_XML.replace('<number>9001</number>', '<number>9002</number>'),
  BILLSTATUS_XML.replace(
    '<congress>118</congress>',
    '<congress>119</congress>',
  ),
  BILLSTATUS_XML.replace('<type>HR</type>', '<type>S</type>'),
  '<!DOCTYPE billStatus [<!ENTITY x SYSTEM "https://evil.test/secret">]><billStatus>&x;</billStatus>',
  '<billStatus>' +
    '<deep>'.repeat(129) +
    '</deep>'.repeat(129) +
    '</billStatus>',
])('rejects malformed, mismatched and entity-based records', (xml) => {
  expect(() => parse(xml)).toThrow();
});

test('invalid UTF-8 fails without substituting corrupted names', () => {
  expect(() =>
    parseGovinfoBillStatus(Uint8Array.from([255]), plan, fetchedAt),
  ).toThrow();
});

test.each([
  ['agreed to', 'adopted'],
  ['not agreed to', 'rejected'],
  ['withdrawn', 'withdrawn'],
  ['offered', 'offered'],
  ['submitted', 'offered'],
  ['motion to table agreed to', 'unknown'],
])('maps only explicit amendment decisions: %s', (text, status) => {
  expect(
    parse(
      BILLSTATUS_XML.replace(
        'Amendment H.Amdt.42 agreed to in House.',
        `Amendment H.Amdt.42 ${text} in House.`,
      ),
    ).history.amendments[0]?.status,
  ).toBe(status);
});

test('reads explicit status and a singular amendment sponsor without inventing fields', () => {
  const xml = BILLSTATUS_XML.replace(
    '<purpose>',
    '<status>withdrawn</status><purpose>',
  ).replace(
    '<sponsors><item><fullName>Rep. Sample, Jamie [I-ME]</fullName><bioguideId>X000002</bioguideId></item></sponsors>',
    '<sponsor><fullName>Sen. Sample, Jamie</fullName></sponsor>',
  );
  expect(parse(xml).history.amendments[0]).toMatchObject({
    status: 'withdrawn',
    sponsor: { name: 'Sen. Sample, Jamie' },
  });
});

test('ignores links to other hosts and other bills; never takes a text URL from XML', () => {
  const xml = BILLSTATUS_XML.replace(
    'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml',
    'https://evil.test/BILLS-118hr9001ih',
  ).replaceAll('BILLS-118hr9001eh', 'BILLS-118hr9002eh');
  expect(parse(xml).history.versions.map((item) => item.code)).toEqual([
    '',
    '',
  ]);
  const unsafe = BILLSTATUS_XML.replace(
    'https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml',
    'https://www.congress.gov/help',
  );
  expect(parse(unsafe).history.versions.map((item) => item.code)).toEqual([
    '',
    'eh',
  ]);
});

test('skips incomplete optional entries and strips summary HTML to plain text', () => {
  const xml = BILLSTATUS_XML.replace(
    '<actions>',
    '<actions><item><text>No date</text></item><item><actionDate>bad</actionDate></item>',
  )
    .replace(
      '<sponsors>',
      '<sponsors><item/><item><fullName>Sen. Unaffiliated Example</fullName></item>',
    )
    .replace(
      '<amendments>',
      '<amendments><amendment><number>1</number></amendment>',
    )
    .replace('<formats>', '<formats><item/><item><url>not a URL</url></item>')
    .replace(
      '<p>The bill creates <b>example grants</b>.</p>',
      '<script>alert(1)</script><p>The bill creates <b>example grants</b>.</p>',
    );
  const result = parse(xml);
  expect(result.history.actions).toHaveLength(2);
  expect(result.history.amendments).toHaveLength(2);
  expect(result.sponsorProfiles[0]).toMatchObject({
    name: 'Sen. Unaffiliated Example',
    chamber: 'senate',
  });
  expect(result.history.officialSummary?.text).not.toContain('alert');
});

test('inline XML text retains word order', () => {
  expect(
    parse(
      BILLSTATUS_XML.replace(
        'Referred to the Example Committee.',
        'Referred to <b>Example</b> Committee.',
      ),
    ).history.actions[0]?.text,
  ).toBe('Referred to Example Committee.');
});
