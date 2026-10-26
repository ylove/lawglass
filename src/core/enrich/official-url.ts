/**
 * Links from a citation to the official text, built by rule. No search engines: a search link
 * would tell a third party what the reader is looking at. A URL comes back only when the
 * citation maps cleanly; anything else (charters, city codes, Acts named but not numbered)
 * gets no link rather than a guess. Pure and dependency-free, so the web can share it.
 */

const ORC = 'https://codes.ohio.gov/ohio-revised-code';
const GOVINFO = 'https://www.govinfo.gov/link';
const ECFR = 'https://www.ecfr.gov/current';
const NYSENATE = 'https://www.nysenate.gov/legislation/laws';

/** GovInfo's Public Law collection starts with the 104th Congress; older laws have no page. */
const FIRST_PLAW_CONGRESS = 104;
/** The eCFR has titles 1 to 50. */
const MAX_CFR_TITLE = 50;

/**
 * New York Open Legislation law ids for the laws we are sure of, keyed by the lowercase name
 * the citation carries ("New York public health law § 1-a"). Anything else gets no link.
 */
const NY_LAW_IDS: Readonly<Record<string, string>> = {
  'public health law': 'PBH',
  'labor law': 'LAB',
  'education law': 'EDN',
  'tax law': 'TAX',
  'penal law': 'PEN',
  'vehicle and traffic law': 'VAT',
  'social services law': 'SOS',
  'executive law': 'EXC',
  'general municipal law': 'GMU',
  'election law': 'ELN',
  'insurance law': 'ISC',
  'general business law': 'GBS',
  'judiciary law': 'JUD',
  'domestic relations law': 'DOM',
  'criminal procedure law': 'CPL',
  'mental hygiene law': 'MHY',
  'environmental conservation law': 'ENV',
  'state finance law': 'STF',
  'public officers law': 'PBO',
  'general obligations law': 'GOB',
};
const NY_CITATION = /^New York ([a-z ]+ law) § (\d+[a-z]?(?:-[a-z0-9]+)*)$/;

/** The U.S. Code has titles 1 to 54. */
const MAX_USC_TITLE = 54;

// A section number is digits, then letters or digits, optionally one dashed tail: "6809",
// "1395w-4", "78o-6". Parenthesized subsections are accepted and dropped ("6809(4)").
const USC_SECTION = String.raw`(\d[A-Za-z0-9]*(?:-[A-Za-z0-9]+)?)`;
const USC_CITATION = new RegExp(
  String.raw`^(\d{1,2}) U\.S\.C\. ${USC_SECTION}(?:\([A-Za-z0-9]+\))*(?: (?:to|through) \d[A-Za-z0-9-]*(?:\([A-Za-z0-9]+\))*)?(?: et seq\.?)?$`,
);
const PUBLIC_LAW = /^(?:Public Law|Pub\. ?L\.|P\.L\.) ?(\d{1,3})[-–](\d{1,4})$/;
const STATUTE = /^(\d{1,3}) Stat\. (\d{1,4})$/;
// A part, then optionally one section of it: "42 CFR 438.3", "12 CFR 1005".
const CFR = /^(\d{1,2}) CFR (\d{1,4})(?:\.(\d{1,4}[A-Za-z]?))?$/;

/** The title and section a U.S. Code citation names. Ranges and "et seq." name their first section. */
export function parseUsCodeCitation(
  citation: string,
): { title: number; section: string } | undefined {
  // GPO prints the dash inside a section number as an en or em dash.
  const m = USC_CITATION.exec(citation.trim().replace(/[–—]/g, '-'));
  if (!m) return undefined;
  const title = Number(m[1]);
  if (title < 1 || title > MAX_USC_TITLE) return undefined;
  // "6801-6809" is a range, not a section: the dash is part of a number only after a letter
  // ("1395w-4"). A range names its first section.
  const section = /^\d+-\d/.test(m[2] ?? '')
    ? (m[2] ?? '').split('-')[0]
    : m[2];
  return { title, section: section ?? '' };
}

/**
 * The GovInfo link service address for a U.S. Code section. It answers with a redirect to the
 * current edition's page, so the link never goes stale when the Code is republished.
 */
export function usCodeUrl(title: number, section: string): string {
  return `${GOVINFO}/uscode/${String(title)}/${encodeURIComponent(section)}?link-type=html`;
}

export function officialUrl(citation: string): string | undefined {
  const text = citation.trim();
  if (text === 'Ohio Revised Code, Title 35') return `${ORC}/title-35`;
  const rcSection = /^R\.C\. (\d+\.\d+(?:\.\d+)?)$/.exec(text);
  if (rcSection)
    return `${ORC}/section-${encodeURIComponent(rcSection[1] ?? '')}`;
  const rcChapter = /^R\.C\. Chapter (\d+(?:\.\d+)?)$/.exec(text);
  if (rcChapter)
    return `${ORC}/chapter-${encodeURIComponent(rcChapter[1] ?? '')}`;

  const usc = parseUsCodeCitation(text);
  if (usc) return usCodeUrl(usc.title, usc.section);

  const law = PUBLIC_LAW.exec(text);
  if (law && Number(law[1]) >= FIRST_PLAW_CONGRESS)
    return `${GOVINFO}/plaw/${law[1] ?? ''}/public/${law[2] ?? ''}?link-type=html`;

  const statute = STATUTE.exec(text);
  if (statute)
    return `${GOVINFO}/statute/${statute[1] ?? ''}/${statute[2] ?? ''}`;

  const cfr = CFR.exec(text);
  if (cfr && Number(cfr[1]) >= 1 && Number(cfr[1]) <= MAX_CFR_TITLE) {
    const title = `${ECFR}/title-${cfr[1] ?? ''}`;
    return cfr[3] === undefined
      ? `${title}/part-${cfr[2] ?? ''}`
      : `${title}/section-${cfr[2] ?? ''}.${cfr[3]}`;
  }

  const ny = NY_CITATION.exec(text);
  const lawId = ny ? NY_LAW_IDS[ny[1] ?? ''] : undefined;
  if (ny && lawId)
    return `${NYSENATE}/${lawId}/${encodeURIComponent(ny[2] ?? '')}`;
  return undefined;
}
