/** Hand-written BILLSTATUS sample. Every person, bill, and amendment here is invented. */
export const BILLSTATUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<billStatus><bill>
  <congress>118</congress><type>HR</type><number>9001</number>
  <sponsors><item><fullName>Rep. Example, Alex [I-OH-3]</fullName><bioguideId>X000001</bioguideId><party>I</party><state>OH</state><district>3</district></item></sponsors>
  <cosponsors><item><firstName>Jamie</firstName><middleName>Q.</middleName><lastName>Sample</lastName><identifiers><bioguideId>X000002</bioguideId></identifiers><party>I</party><state>ME</state><chamber>House</chamber></item></cosponsors>
  <actions><item><actionDate>2024-01-02</actionDate><text>Referred to the Example Committee.</text><sourceSystem><name>House</name></sourceSystem><committee><name>Example Committee</name></committee></item>
    <item><actionDate>2024-06-10</actionDate><text>Passed House.</text><chamber>House</chamber></item></actions>
  <amendments><amendment><congress>118</congress><type>HAMDT</type><number>42</number><purpose>To clarify the example grant limit.</purpose><description>Clarifies eligibility.</description><sponsors><item><fullName>Rep. Sample, Jamie [I-ME]</fullName><bioguideId>X000002</bioguideId></item></sponsors><latestAction><actionDate>2024-06-10</actionDate><text>Amendment H.Amdt.42 agreed to in House.</text></latestAction></amendment>
    <amendment><congress>118</congress><type>HAMDT</type><number>43</number><latestAction><actionDate>2024-06-10</actionDate><text>Considered by the House.</text></latestAction></amendment></amendments>
  <textVersions><item><date>2024-01-02T00:00:00Z</date><type>Introduced in House</type><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml</url></item></formats></item>
    <item><date>2024-06-10T00:00:00Z</date><type>Engrossed in House</type><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001eh/pdf/BILLS-118hr9001eh.pdf</url></item></formats></item></textVersions>
  <summaries><billSummaries><item><actionDate>2024-01-02</actionDate><text><![CDATA[<p>The introduced bill creates example grants.</p>]]></text></item>
    <item><actionDate>2024-06-10</actionDate><updateDate>2024-06-11T00:00:00Z</updateDate><text><![CDATA[<p>The bill creates <b>example grants</b>.</p><p>It clarifies eligibility &amp; limits.</p>]]></text></item></billSummaries></summaries>
</bill></billStatus>`;

export function makeBillStatusXml(): Uint8Array {
  return new TextEncoder().encode(BILLSTATUS_XML);
}
