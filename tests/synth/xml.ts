import type {
  BillMetadata,
  Definition,
  ExternalRef,
} from '../../src/core/model/index.js';
import type { SampleGroundTruth, SyntheticSample } from './types.js';

export interface CongressionalGroundTruth extends SampleGroundTruth {
  metadata: BillMetadata;
  definitions: Definition[];
  externalRefs: ExternalRef[];
  internalRefs: { text: string; target: string }[];
  quotedText: string;
}

/**
 * Govinfo element shapes; every name and passage is invented. Like real files it carries a
 * DOCTYPE (a system id that must never be fetched), Dublin Core metadata and hex element
 * ids, so parsers must build section ids from enums, not from XML ids. No entity declarations.
 */
export function makeCongressionalBillXml(): SyntheticSample<CongressionalGroundTruth> {
  return {
    bytes: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="billres.xsl"?>
<!DOCTYPE bill PUBLIC "-//US Congress//DTDs/bill.dtd//EN" "bill.dtd">
<bill bill-stage="Introduced-in-Senate" dms-id="A1" public-private="public">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dublinCore>
      <dc:title>119 S9001 IS: Synthetic garden grants act</dc:title>
      <dc:publisher>U.S. Senate</dc:publisher>
      <dc:date>2027-01-15</dc:date>
      <dc:format>text/xml</dc:format>
      <dc:language>EN</dc:language>
    </dublinCore>
  </metadata>
  <form>
    <distribution-code display="yes">II</distribution-code>
    <congress>119th CONGRESS</congress><session>1st Session</session>
    <legis-num>S. 9001</legis-num>
    <current-chamber>IN THE SENATE OF THE UNITED STATES</current-chamber>
    <action><action-date date="20270115">January 15, 2027</action-date>
      <action-desc><sponsor name-id="SYN1">Senator Rowan Example</sponsor>
      (for herself and <cosponsor name-id="SYN2">Senator Avery Sample</cosponsor>)
      introduced the following bill.</action-desc>
    </action>
    <legis-type>A BILL</legis-type>
    <official-title>To establish shared garden grants &amp; seed libraries.</official-title>
  </form>
  <legis-body>
    <section id="id33c97728de7044c89797d979f7d597b5" commented="no" display-inline="no-display-inline">
      <enum>1.</enum><header>Definitions</header>
      <text>In this Act:</text>
      <subsection id="idd189b7d000bc4651952ff48bcadab67c"><enum>(a)</enum><header>Garden groups</header>
        <paragraph id="id8a48b20837ea4d65817fc093e1951e7d"><enum>(1)</enum><header>Eligible group</header>
          <text>The term <term>garden group</term> means a nonprofit that maintains a shared garden.</text>
        </paragraph>
      </subsection>
    </section>
    <section id="id761e3361e28447a28b2863dd5d74e017"><enum>2.</enum><header>Grants</header>
      <text>A group described in <internal-xref idref="id8a48b20837ea4d65817fc093e1951e7d">section 1(a)(1)</internal-xref>
      may apply using the size rule in <external-xref legal-doc="usc" parsable-cite="usc/15/632">15 U.S.C. 632</external-xref>.</text>
      <quoted-block><text>Award notices shall state the planting season.</text></quoted-block>
    </section>
    <section id="idef1890e9f2194fcdac62ca44a24a6bcd"><enum>3.</enum><header>Effective date</header>
      <text>This Act takes effect ninety days after enactment.</text>
    </section>
  </legis-body>
</bill>`),
    groundTruth: {
      deletedStrings: [],
      insertedStrings: [],
      metadata: {
        title: 'To establish shared garden grants & seed libraries.',
        billNumber: 'S. 9001',
        jurisdiction: 'United States',
        session: '119th CONGRESS, 1st Session',
        version: 'Introduced-in-Senate',
        sponsors: ['Senator Rowan Example', 'Senator Avery Sample'],
        source: 'structured',
      },
      definitions: [
        {
          term: 'garden group',
          text: 'The term garden group means a nonprofit that maintains a shared garden.',
          sectionId: 'sec-1/a/1',
          scope: 'document',
        },
      ],
      externalRefs: [
        {
          text: '15 U.S.C. 632',
          citation: '15 U.S.C. 632',
          kind: 'us_code',
          sectionIds: ['sec-2'],
        },
      ],
      internalRefs: [{ text: 'section 1(a)(1)', target: 'sec-1/a/1' }],
      quotedText: 'Award notices shall state the planting season.',
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Definitions',
          level: 1,
          spans: [{ text: 'In this Act:', status: 'unchanged' }],
          children: [
            {
              id: 'sec-1/a',
              num: '(a)',
              heading: 'Garden groups',
              level: 2,
              spans: [],
              children: [
                {
                  id: 'sec-1/a/1',
                  num: '(1)',
                  heading: 'Eligible group',
                  level: 3,
                  children: [],
                  spans: [
                    {
                      text: 'The term garden group means a nonprofit that maintains a shared garden.',
                      status: 'unchanged',
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Grants',
          level: 1,
          children: [],
          spans: [
            {
              text: 'A group described in section 1(a)(1) may apply using the size rule in 15 U.S.C. 632. Award notices shall state the planting season.',
              status: 'unchanged',
            },
          ],
        },
        {
          id: 'sec-3',
          num: '3',
          heading: 'Effective date',
          level: 1,
          children: [],
          spans: [
            {
              text: 'This Act takes effect ninety days after enactment.',
              status: 'unchanged',
            },
          ],
        },
      ],
    },
  };
}

export interface UslmGroundTruth extends SampleGroundTruth {
  namespace: string;
}

export function makeUslmXml(): SyntheticSample<UslmGroundTruth> {
  return {
    bytes: new TextEncoder().encode(`<?xml version="1.0" encoding="UTF-8"?>
<bill xmlns="http://xml.house.gov/schemas/uslm/1.0">
  <meta><title>Synthetic Seed Library Amendment</title></meta>
  <main>
    <section id="sec-1"><num value="1">Section 1.</num><heading>Loan period</heading>
      <content><p>A seed loan lasts <del>thirty days</del><ins>sixty days</ins>.</p></content>
    </section>
    <section id="sec-2"><num value="2">Section 2.</num><heading>Reports</heading>
      <content><p>The library shall report <del>monthly</del><ins>annually</ins>.</p></content>
    </section>
    <section id="sec-3"><num value="3">Section 3.</num><heading>Branch hours</heading>
      <chapeau>Each branch shall:</chapeau>
      <subsection id="sec-3-a"><num value="a">(a)</num><heading>Opening</heading>
        <content><p>Open <ins>six</ins> days a week.</p></content>
      </subsection>
      <subsection id="sec-3-b"><num value="b">(b)</num><heading>Records</heading>
        <paragraph id="sec-3-b-1"><num value="1">(1)</num>
          <content><p>Keep a <del>paper</del> log.</p></content>
        </paragraph>
      </subsection>
    </section>
  </main>
</bill>`),
    groundTruth: {
      namespace: 'http://xml.house.gov/schemas/uslm/1.0',
      deletedStrings: ['thirty days', 'monthly', 'paper'],
      insertedStrings: ['sixty days', 'annually', 'six'],
      sections: [
        {
          id: 'sec-1',
          num: '1',
          heading: 'Loan period',
          level: 1,
          children: [],
          spans: [
            { text: 'A seed loan lasts ', status: 'unchanged' },
            { text: 'thirty days', status: 'deleted' },
            { text: 'sixty days', status: 'inserted' },
            { text: '.', status: 'unchanged' },
          ],
        },
        {
          id: 'sec-2',
          num: '2',
          heading: 'Reports',
          level: 1,
          children: [],
          spans: [
            { text: 'The library shall report ', status: 'unchanged' },
            { text: 'monthly', status: 'deleted' },
            { text: 'annually', status: 'inserted' },
            { text: '.', status: 'unchanged' },
          ],
        },
        {
          id: 'sec-3',
          num: '3',
          heading: 'Branch hours',
          level: 1,
          spans: [{ text: 'Each branch shall:', status: 'unchanged' }],
          children: [
            {
              id: 'sec-3/a',
              num: '(a)',
              heading: 'Opening',
              level: 2,
              children: [],
              spans: [
                { text: 'Open ', status: 'unchanged' },
                { text: 'six', status: 'inserted' },
                { text: ' days a week.', status: 'unchanged' },
              ],
            },
            {
              id: 'sec-3/b',
              num: '(b)',
              heading: 'Records',
              level: 2,
              spans: [],
              children: [
                {
                  id: 'sec-3/b/1',
                  num: '(1)',
                  level: 3,
                  children: [],
                  spans: [
                    { text: 'Keep a ', status: 'unchanged' },
                    { text: 'paper', status: 'deleted' },
                    { text: ' log.', status: 'unchanged' },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}
