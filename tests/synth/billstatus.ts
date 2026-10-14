/**
 * Invented records using the nesting inspected in GovInfo's hr5009, s202 and hr4366 files.
 * No real legislation or member data is included.
 */
export const BILLSTATUS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<billStatus><bill>
  <number>9001</number><originChamber>House</originChamber><originChamberCode>H</originChamberCode>
  <type>HR</type><introducedDate>2023-07-27</introducedDate><congress>118</congress>
  <actions>
    <item><actionDate>2024-06-10</actionDate><text>Passed House.</text><type>Floor</type><sourceSystem><code>2</code><name>House floor actions</name></sourceSystem></item>
    <item><actionDate>2024-01-02</actionDate><committees><item><systemCode>hsex00</systemCode><name>Example Committee</name></item></committees><sourceSystem><name>House</name></sourceSystem><text>Referred to the Example Committee.</text><type>IntroReferral</type></item>
  </actions>
  <sponsors><item><bioguideId>X000001</bioguideId><fullName>Rep. Example, Alex [I-OH-3]</fullName><firstName>Alex</firstName><lastName>Example</lastName><party>I</party><state>OH</state><district>3</district><isByRequest>N</isByRequest></item></sponsors>
  <cosponsors><item><bioguideId>X000002</bioguideId><fullName>Rep. Sample, Jamie Q. [I-ME-1]</fullName><firstName>Jamie</firstName><lastName>Sample</lastName><party>I</party><state>ME</state><middleName>Q.</middleName><district>1</district><sponsorshipDate>2024-01-02</sponsorshipDate><isOriginalCosponsor>True</isOriginalCosponsor></item></cosponsors>
  <amendments>
    <amendment><number>42</number><congress>118</congress><type>HAMDT</type><description>Clarifies eligibility.</description><purpose>To clarify the example grant limit.</purpose><updateDate>2024-06-11T00:00:00Z</updateDate><latestAction><actionDate>2024-06-10</actionDate><text>On agreeing to the Sample amendment (A001) Agreed to by voice vote.</text></latestAction><sponsors><item><bioguideId>X000002</bioguideId><fullName>Rep. Sample, Jamie [I-ME]</fullName><firstName>Jamie</firstName><lastName>Sample</lastName><party>I</party><state>ME</state></item></sponsors><submittedDate>2024-06-10T04:00:00Z</submittedDate><chamber>House of Representatives</chamber><actions><count>1</count><actions><item><actionDate>2024-06-10</actionDate><text>On agreeing to the Sample amendment (A001) Agreed to by voice vote.</text></item></actions></actions></amendment>
    <amendment><number>43</number><congress>118</congress><type>SAMDT</type><latestAction><actionDate>2024-06-10</actionDate><text>SA 43 fell when SA 41 was withdrawn.</text></latestAction></amendment>
  </amendments>
  <textVersions>
    <item><type>Enrolled Bill</type><date/><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001enr/xml/BILLS-118hr9001enr.xml</url></item></formats></item>
    <item><type>Engrossed Amendment House</type><date>2024-12-11T05:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001eah/xml/BILLS-118hr9001eah.xml</url></item></formats></item>
    <item><type>Engrossed Amendment Senate</type><date>2024-09-24T04:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001eas/xml/BILLS-118hr9001eas.xml</url></item></formats></item>
    <item><type>Placed on Calendar Senate</type><date>2024-02-06T05:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001pcs/xml/BILLS-118hr9001pcs.xml</url></item></formats></item>
    <item><type>Engrossed in House</type><date>2024-02-05T05:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001eh/xml/BILLS-118hr9001eh.xml</url></item></formats></item>
    <item><type>Reported in House</type><date>2024-01-30T05:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001rh/xml/BILLS-118hr9001rh.xml</url></item></formats></item>
    <item><type>Introduced in House</type><date>2023-07-27T04:00:00Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/BILLS-118hr9001ih/xml/BILLS-118hr9001ih.xml</url></item></formats></item>
    <item><type>Public Law</type><date>2024-12-24T04:59:59Z</date><formats><item><url>https://www.govinfo.gov/content/pkg/PLAW-118publ999/uslm/PLAW-118publ999.xml</url></item></formats></item>
  </textVersions>
  <summaries>
    <summary><versionCode>00</versionCode><actionDate>2024-01-02</actionDate><actionDesc>Introduced in House</actionDesc><updateDate>2024-06-12T00:00:00Z</updateDate><cdata><text>&lt;p&gt;The introduced bill creates example grants.&lt;/p&gt;</text></cdata></summary>
    <summary><versionCode>07</versionCode><actionDate>2024-06-10</actionDate><actionDesc>Passed House</actionDesc><updateDate>2024-06-11T00:00:00Z</updateDate><cdata><text>&lt;p&gt;The bill creates &lt;b&gt;example grants&lt;/b&gt;.&lt;/p&gt;&lt;p&gt;It clarifies eligibility &amp;amp; limits.&lt;/p&gt;</text></cdata></summary>
  </summaries>
</bill></billStatus>`;

export function makeBillStatusXml(): Uint8Array {
  return new TextEncoder().encode(BILLSTATUS_XML);
}
