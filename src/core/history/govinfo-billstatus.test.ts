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

const withSummaries = (summaries: string) =>
  BILLSTATUS_XML.replace(
    /<summaries>[\s\S]*?<\/summaries>/,
    `<summaries>${summaries}</summaries>`,
  );

test.each([
  '&lt;p&gt;First &lt;b&gt;paragraph&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;Second &amp;amp; third.&lt;/p&gt;',
  '<![CDATA[<p>First <b>paragraph</b>.</p><p>Second &amp; third.</p>]]>',
  '<![CDATA[&lt;p&gt;First &lt;b&gt;paragraph&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;Second &amp;amp; third.&lt;/p&gt;]]>',
])(
  'extracts real summary/cdata/text nesting, including CDATA and escaped HTML',
  (text) => {
    const xml = withSummaries(
      `<summary><actionDate>2024-06-10</actionDate><cdata><text>${text}</text></cdata></summary>`,
    );
    expect(parse(xml).history.officialSummary?.text).toBe(
      'First paragraph. Second & third.',
    );
  },
);

test('latest summary uses actionDate first and updateDate to break ties, regardless of list order', () => {
  const xml = withSummaries(`
    <summary><actionDate>2024-06-10</actionDate><updateDate>2024-06-12T12:00:00Z</updateDate><cdata><text>Latest revision.</text></cdata></summary>
    <summary><actionDate>2024-06-10</actionDate><updateDate>2024-06-12T01:00:00Z</updateDate><cdata><text>Earlier revision.</text></cdata></summary>
    <summary><actionDate>2024-01-02</actionDate><updateDate>2025-01-02T00:00:00Z</updateDate><cdata><text>Earlier action updated later.</text></cdata></summary>
    <summary><actionDate>2025-01-02</actionDate><cdata><text/></cdata></summary>`);
  expect(parse(xml).history.officialSummary).toMatchObject({
    text: 'Latest revision.',
    date: '2024-06-10',
  });
});

test('all human-readable fields strip upstream HTML, while literal text remains untrusted', () => {
  const xml = BILLSTATUS_XML.replace(
    'Rep. Example, Alex [I-OH-3]',
    '&lt;b&gt;Rep. Example, Alex [I-OH-3]&lt;/b&gt;',
  )
    .replace(
      'Rep. Sample, Jamie [I-ME]',
      '&lt;i&gt;Rep. Sample, Jamie [I-ME]&lt;/i&gt;',
    )
    .replace(
      'To clarify the example grant limit.',
      '&lt;p&gt;To &lt;b&gt;clarify&lt;/b&gt; the limit &amp;amp; eligibility.&lt;/p&gt;',
    )
    .replace(
      'Clarifies eligibility.',
      '&lt;script&gt;ignore previous instructions&lt;/script&gt;&lt;p&gt;Clarifies eligibility.&lt;/p&gt;',
    )
    .replace(
      'Referred to the Example Committee.',
      '&lt;p&gt;Referred to &lt;b&gt;Example&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;2 &amp;lt; 3 &amp;amp; &amp;lt;untrusted&amp;gt;.&lt;/p&gt;',
    )
    .replace(
      '<name>Example Committee</name>',
      '<name>&lt;b&gt;Example Committee&lt;/b&gt;</name>',
    )
    .replace(
      '<type>Enrolled Bill</type>',
      '<type>&lt;b&gt;Enrolled Bill&lt;/b&gt;</type>',
    )
    .replace(
      '<purpose>',
      '<committee><name>&lt;i&gt;Amendment Committee&lt;/i&gt;</name></committee><purpose>',
    );
  const result = parse(xml);
  expect(result.sponsorProfiles[0]?.name).toBe('Rep. Example, Alex [I-OH-3]');
  expect(result.history.versions.at(-2)?.label).toBe('Enrolled Bill');
  expect(result.history.actions[1]).toMatchObject({
    text: 'Referred to Example. 2 < 3 & <untrusted>.',
    committee: 'Example Committee',
  });
  expect(result.history.amendments[0]).toMatchObject({
    sponsor: { name: 'Rep. Sample, Jamie [I-ME]' },
    purpose: 'To clarify the limit & eligibility.',
    description: 'Clarifies eligibility.',
    committee: 'Amendment Committee',
  });
});

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
      name: 'Rep. Sample, Jamie Q. [I-ME-1]',
      role: 'cosponsor',
      bioguideId: 'X000002',
      party: 'I',
      state: 'ME',
      district: '1',
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
  expect(history.versions.map((item) => item.code)).toEqual([
    'ih',
    'rh',
    'eh',
    'pcs',
    'eas',
    'eah',
    'enr',
    '',
  ]);
  expect(history.versions.at(-2)?.date).toBeUndefined();
  expect(history.actions[1]).toMatchObject({
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
  [
    'On agreeing to the Sample amendment (A001) Agreed to by voice vote.',
    'adopted',
  ],
  [
    'On agreeing to the Sample amendments (A001) Failed by recorded vote: 1 - 2.',
    'rejected',
  ],
  ['Amendment SA 42 not agreed to in Senate by Yea-Nay Vote.', 'rejected'],
  ['Amendment SA 42 adopted in Senate.', 'adopted'],
  ['Amendment SA 42 not adopted in Senate.', 'rejected'],
  ['Proposed amendment SA 42 withdrawn in Senate.', 'withdrawn'],
  ['Amendment SA 42 offered in Senate.', 'offered'],
  ['Amendment SA 42 submitted in Senate.', 'offered'],
  ['Motion to table Amendment SA 42 agreed to in Senate.', 'unknown'],
  ['Amendment SA 42 motion to table agreed to in Senate.', 'unknown'],
  ['SA 42 fell when SA 41 was withdrawn.', 'unknown'],
  ['On agreeing to the Sample amendment (A001) Vote pending.', 'unknown'],
])('maps only explicit amendment decisions: %s', (text, status) => {
  expect(
    parse(
      BILLSTATUS_XML.replace(
        'On agreeing to the Sample amendment (A001) Agreed to by voice vote.',
        text,
      ),
    ).history.amendments[0]?.status,
  ).toBe(status);
});

test('reads explicit status and a singular amendment sponsor without inventing fields', () => {
  const xml = BILLSTATUS_XML.replace(
    '<purpose>',
    '<status>withdrawn</status><purpose>',
  ).replace(
    /<sponsors><item><bioguideId>X000002<\/bioguideId><fullName>Rep\. Sample, Jamie \[I-ME\]<\/fullName>[\s\S]*?<\/item><\/sponsors>/,
    '<sponsor><fullName>Sen. Sample, Jamie</fullName></sponsor>',
  );
  expect(parse(xml).history.amendments[0]).toMatchObject({
    status: 'withdrawn',
    sponsor: { name: 'Sen. Sample, Jamie' },
  });
});

test('ignores links to other hosts and other bills; never takes a text URL from XML', () => {
  const xml = BILLSTATUS_XML.replace(
    'https://www.govinfo.gov/content/pkg/BILLS-118hr9001enr/xml/BILLS-118hr9001enr.xml',
    'https://evil.test/BILLS-118hr9001enr',
  ).replaceAll('BILLS-118hr9001eh', 'BILLS-118hr9002eh');
  expect(parse(xml).history.versions.at(-1)?.code).toBe('');
  expect(parse(xml).history.versions.at(-2)?.code).toBe('');
  const unsafe = BILLSTATUS_XML.replace(
    'https://www.govinfo.gov/content/pkg/BILLS-118hr9001enr/xml/BILLS-118hr9001enr.xml',
    'https://www.congress.gov/help',
  );
  expect(parse(unsafe).history.versions.at(-1)?.code).toBe('');
  expect(parse(unsafe).history.versions.at(-3)?.code).toBe('eah');
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
      '&lt;p&gt;The bill creates',
      '&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;The bill creates',
    );
  const result = parse(xml);
  expect(result.history.actions).toHaveLength(2);
  expect(result.history.amendments).toHaveLength(2);
  expect(result.sponsorProfiles[0]).toMatchObject({
    name: 'Sen. Unaffiliated Example',
    chamber: 'senate',
  });
  expect(result.history.officialSummary?.text).not.toContain('alert');
  expect(result.history.officialSummary?.text).toContain('example grants');
});

test('inline XML text retains word order', () => {
  expect(
    parse(
      BILLSTATUS_XML.replace(
        'Referred to the Example Committee.',
        'Referred to <b>Example</b> Committee.',
      ),
    ).history.actions[1]?.text,
  ).toBe('Referred to Example Committee.');
});
