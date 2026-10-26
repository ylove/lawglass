// Scripted in-browser stand-in for the server, enabled with `?mock=1` (or VITE_MOCK_API).
// It speaks the same contracts as the real API, so the whole UI can be demoed and tested
// without a server. All content is invented; it is not real legislation.
import {
  findCitationIds,
  DECLINE_TEXT,
  type AnswerResult,
  type AskEvent,
  type AskRequest,
  type BillHistory,
  type BreakdownResponse,
  type SectionBrief,
  type ChipId,
  type ClientConfig,
  type DocDetail,
  type DocSummary,
  type IngestEvent,
  type IngestRequest,
  type PictureEntry,
  type PicturesResponse,
  type Scenario,
  type ScenarioRequest,
  type ScanStatus,
  type ScenarioResponse,
  type SectionExcerpt,
  type SponsorProfile,
  type SummaryResponse,
} from '../core/model/index.js';
import { listItems } from '../core/answer/list-items.js';
import { BRAND } from '../core/brand.js';
import { NO_EXAMPLE_NOTE } from '../core/breakdown/notes.js';
import type { ApiClient } from './api.js';
import { ApiError } from './sse.js';

export interface MockApiOptions {
  /** Delay between scripted events. Tests pass 0. */
  delayMs?: number;
  /** Simulates a public server: no freeform questions. */
  publicMode?: boolean;
}

export const MOCK_HINT =
  'Demo mode. Any web address works. Try one containing "wrapper" to see the file picker, "fail" to see an error, or ending in .xml for a document without page and line numbers. One containing "charter" gives a scanned city charter amendment.';

const CHIPS: ClientConfig['chips'] = [
  { id: 'summary', label: 'Summarize this bill' },
  { id: 'what-changes', label: 'What does it change?' },
  { id: 'who-affected', label: 'Who does it affect?' },
  { id: 'history', label: 'How did it get here?' },
  { id: 'penalties', label: 'Penalties and enforcement' },
  { id: 'effective-date', label: 'When does it take effect?' },
  { id: 'delegations', label: 'Who decides later?' },
  { id: 'money', label: 'Taxes, fees, and spending' },
  { id: 'definitions', label: 'Key definitions' },
  { id: 'sponsors', label: 'Who sponsored it?' },
];

/** Suggested subjects for the sample bill, as the server derives them from a bill's own words. */
const SAMPLE_PERSONAS = [
  'a renter',
  'a homeowner',
  'a taxpayer',
  'a small business owner',
] as const;
const MOCK_JUDGING = /\b(?:good|bad|unfair|fair|harmful|burden\w*)\b/i;

const SAMPLE_ID = 'a'.repeat(64);
const NOW = '2026-10-13T12:00:00.000Z';

const SAMPLE_DOC: DocSummary = {
  docId: SAMPLE_ID,
  label: 'Clean Water Infrastructure Act',
  sourceUrl: 'https://example.gov/bills/hb214.pdf',
  format: 'pdf',
  title: 'Clean Water Infrastructure Act',
  billNumber: 'HB 214',
  ingestedAt: NOW,
  lastUsedAt: NOW,
  backend: 'local',
};

interface MockSection {
  id: string;
  breadcrumb: string;
  num: string;
  heading: string;
  spans: SectionExcerpt['spans'];
  page: number;
  lines: [number, number];
}

const SECTIONS: MockSection[] = [
  {
    id: 'sec-1',
    breadcrumb: 'Clean Water Infrastructure Act > Section 1',
    num: '1',
    heading: 'Short title',
    spans: [
      {
        text: 'This act may be cited as the Clean Water Infrastructure Act.',
        status: 'unchanged',
      },
    ],
    page: 1,
    lines: [3, 4],
  },
  {
    id: 'sec-2/a',
    breadcrumb: 'Clean Water Infrastructure Act > Section 2 > (a)',
    num: '2(a)',
    heading: 'Definitions',
    spans: [
      {
        text: '"Public water system" means a system that supplies drinking water to at least 25 people. ',
        status: 'unchanged',
      },
      {
        text: '"Utility" means any public or private operator of a public water system.',
        status: 'unchanged',
      },
    ],
    page: 1,
    lines: [10, 14],
  },
  {
    id: 'sec-4/b',
    breadcrumb: 'Clean Water Infrastructure Act > Section 4 > (b)',
    num: '4(b)',
    heading: 'Lead pipe replacement',
    spans: [
      {
        text: 'A utility shall replace each lead service line ',
        status: 'unchanged',
      },
      { text: 'within fifteen years', status: 'deleted' },
      { text: 'within ten years', status: 'inserted' },
      {
        text: ' after the effective date of this act.\n(1) The utility shall notify each affected household in writing.\n(2) ',
        status: 'unchanged',
      },
      {
        text: 'Notice may be given by posting at the utility office.',
        status: 'deleted',
      },
    ],
    page: 3,
    lines: [5, 12],
  },
  {
    id: 'sec-5',
    breadcrumb: 'Clean Water Infrastructure Act > Section 5',
    num: '5',
    heading: 'Annual report',
    spans: [
      {
        text: 'Each utility shall file an annual report with the state agency listing the lead service lines it has replaced.',
        status: 'unchanged',
      },
    ],
    page: 4,
    lines: [1, 3],
  },
  {
    id: 'sec-6',
    breadcrumb: 'Clean Water Infrastructure Act > Section 6',
    num: '6',
    heading: 'Penalties',
    spans: [
      {
        text: 'A utility that fails to meet a deadline under section 4 may be fined up to $1,000 for each day of delay.',
        status: 'unchanged',
      },
    ],
    page: 4,
    lines: [1, 3],
  },
  {
    id: 'sec-7',
    breadcrumb: 'Clean Water Infrastructure Act > Section 7',
    num: '7',
    heading: 'Effective date',
    spans: [
      {
        text: 'This act takes effect on July 1, 2027.',
        status: 'unchanged',
      },
    ],
    page: 5,
    lines: [2, 2],
  },
];

/** The demo charter amendment's own summary, so it does not read as the water bill. */
const CHARTER_SUMMARY =
  'This charter amendment changes how the city council is elected [S:sec-1] and how vacancies are filled [S:sec-2]. It would take effect on January 1, 2027 if voters approve it.';

const ANSWERS: Record<ChipId, string> = {
  summary:
    'This bill requires water utilities to replace lead pipes and sets fines for missing the deadline [S:sec-4/b]. It takes effect on July 1, 2027 [S:sec-7].\n\nMain parts:\n- Who does the work: city-run utilities, private water companies, and companies the state approves [S:sec-2/a]\n- Money and reports: a utility must set aside money equal to the cost of each replacement, and report to the state every year [S:sec-5]\n- Deadlines and fines: ten years to replace each line, and up to $1,000 for each day late [S:sec-6]\n- Legal status: the act stays a draft until the council votes to pass it [S:sec-1]',
  'what-changes':
    'The bill shortens the deadline for replacing lead service lines from fifteen years to ten years [S:sec-4/b]. It also removes a rule that allowed notice by posting at the utility office [S:sec-4/b].',
  'who-affected':
    'Water utilities must replace lead pipes [S:sec-4/b]. Households served by those utilities must be told in writing before work happens [S:sec-4/b].',
  penalties:
    'A utility that misses a deadline can be fined up to $1,000 for each day of delay [S:sec-6].',
  'effective-date': 'The act takes effect on July 1, 2027 [S:sec-7].',
  money:
    'The only dollar amount in the text is the daily fine of up to $1,000 for a late utility [S:sec-6]. The bill does not set aside money for the pipe work.',
  definitions:
    '- Public water system: a system that supplies drinking water to at least 25 people [S:sec-2/a].\n- Utility: any public or private operator of a public water system [S:sec-2/a].',
  history:
    'Here is what the official record says about how this bill got here.\n\nKey actions:\n- 2026-02-03: Introduced in the House.\n- 2026-03-10: Reported by the House Water Committee.\n\nThe record lists no amendments to this bill.',
  sponsors:
    'Sponsored by Rep. A. Rivera, Rep. J. Chen. Cosponsors, if any, are not included.',
  delegations:
    'The water department will write the detailed rules later, and the fine only works once the council sets the daily rate [S:sec-6].\n\n**Decided later by**\n- The water department: the rules for notifying households [S:sec-4/b]\n- The city council: the daily fine rate (not later than 90 days after enactment) [S:sec-6]\n\n**Depends on**\n- Funding set aside by the council in a later budget [S:sec-6]\n\n**Takes effect when**\n- July 1, 2027 [S:sec-7]',
};

/** Invented example for the `who-affected` demo. Every frame cites a section the answer cites. */
const SAMPLE_SCENARIO: Scenario = {
  subject: 'Lead pipe replacement',
  profile: {
    name: 'Sam',
    label: 'Example household',
    illustrative: true,
    assumptions: [],
  },
  frames: [
    {
      kind: 'setup',
      avatar: 'family',
      icon: 'house',
      caption: 'This is Sam. Example household.',
      citations: [],
    },
    {
      kind: 'rule',
      avatar: 'family',
      icon: 'water',
      caption: 'The utility must replace lead pipes.',
      citations: ['sec-4/b'],
    },
    {
      kind: 'effect',
      avatar: 'family',
      icon: 'document',
      caption: 'Sam is told in writing before work happens.',
      citations: ['sec-4/b'],
    },
  ],
};

/**
 * Invented, federal-shaped record: versions oldest first, actions, one adopted amendment. It
 * exercises every part of `BillHistory` the real adapters fill (spec amendment 10).
 */
const SAMPLE_HISTORY: BillHistory = {
  officialSummary: {
    text: 'This bill requires water utilities to replace lead service lines within ten years and sets daily fines for missing the deadline. It also requires written notice to affected households.',
    source: 'Congressional Research Service',
    url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr214.xml',
    date: '2026-03-10',
  },
  versions: [
    {
      code: 'ih',
      label: 'Introduced in House',
      date: '2026-02-03',
      url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr214ih/xml/BILLS-119hr214ih.xml',
    },
    {
      code: 'rh',
      label: 'Reported in House',
      date: '2026-03-10',
      url: 'https://www.govinfo.gov/content/pkg/BILLS-119hr214rh/xml/BILLS-119hr214rh.xml',
    },
  ],
  actions: [
    {
      date: '2026-02-03',
      text: 'Introduced in the House.',
      chamber: 'House',
    },
    {
      date: '2026-02-03',
      text: 'Referred to the House Water Committee.',
      chamber: 'House',
      committee: 'House Water Committee',
    },
    {
      date: '2026-03-10',
      text: 'Reported by the House Water Committee.',
      chamber: 'House',
      committee: 'House Water Committee',
    },
  ],
  amendments: [
    {
      id: '119hamdt1',
      number: '1',
      status: 'adopted',
      sponsor: { name: 'Rep. J. Chen', bioguideId: 'X000002' },
      committee: 'House Water Committee',
      purpose: 'To shorten the lead pipe replacement deadline.',
      date: '2026-03-10',
    },
  ],
  sources: [
    {
      host: 'www.govinfo.gov',
      url: 'https://www.govinfo.gov/bulkdata/BILLSTATUS/119/hr/BILLSTATUS-119hr214.xml',
      fetchedAt: NOW,
    },
  ],
};

/** One link the official record verifies, one the app only searched for (spec amendment 11). */
const SAMPLE_SPONSORS: SponsorProfile[] = [
  {
    name: 'Rep. A. Rivera',
    role: 'sponsor',
    party: 'D',
    state: 'XX',
    chamber: 'house',
    bioguideId: 'X000001',
    links: [
      {
        kind: 'official',
        url: 'https://rivera.house.gov/',
        label: 'Official website',
        verified: true,
      },
    ],
  },
  {
    name: 'Rep. J. Chen',
    role: 'cosponsor',
    party: 'R',
    state: 'XX',
    chamber: 'house',
    links: [
      {
        kind: 'search',
        url: 'https://ballotpedia.org/wiki/index.php?search=J.%20Chen',
        label: 'Search Ballotpedia',
        verified: false,
      },
    ],
  },
];

/** Invented briefs for the sample bill: two with an example, one without (a report). */
const SAMPLE_BRIEFS: readonly {
  sectionId: string;
  text: string;
  example: SectionBrief['example'];
}[] = [
  {
    sectionId: 'sec-4/b',
    text: 'A utility has ten years to replace each lead service line, down from fifteen [S:sec-4/b]. It must tell each affected household in writing [S:sec-4/b].',
    example: 'available',
  },
  {
    sectionId: 'sec-5',
    text: 'A utility sends the state an annual report on the lead lines it has replaced [S:sec-5].',
    example: 'none',
  },
  {
    sectionId: 'sec-6',
    text: 'A utility that misses a deadline can be fined up to $1,000 for each day of delay [S:sec-6].',
    example: 'available',
  },
];

/**
 * Pictures for the sample briefs; the report brief (sec-5) stays plain text. As on the server,
 * every label is made of words from the brief's own text.
 */
const BRIEF_PICTURE_PANELS: Record<string, PictureEntry['panels']> = {
  'sec-4/b': [
    {
      left: { glyphs: ['water'], label: 'Lead line' },
      link: 'to',
      right: { glyphs: ['calendar'], label: 'Ten years' },
    },
    {
      left: { glyphs: ['business'], label: 'Utility' },
      link: 'to',
      carry: 'mail',
      right: { glyphs: ['house'], label: 'Household' },
    },
  ],
  'sec-6': [
    {
      left: { glyphs: ['business'], label: 'Utility' },
      link: 'to',
      carry: 'money',
      right: { glyphs: ['government'], label: '$1,000' },
    },
  ],
};

/**
 * Pictures for the sample summary's bullets, in the grammar of core/model/picture.ts. The first
 * two follow the product owner's examples (one source, three kinds of approval; money that must
 * equal an amount set aside, plus a yearly report). The last bullet has no picture, so the page
 * also shows an item that stays plain text. Labels use only words of the bullet they illustrate.
 */
const SUMMARY_PICTURE_PANELS: readonly PictureEntry['panels'][] = [
  [
    {
      left: { glyphs: ['government'], label: 'City' },
      link: 'to',
      carry: 'water',
      right: { glyphs: ['house'] },
    },
    {
      left: { glyphs: ['business'], label: 'Private' },
      link: 'to',
      carry: 'water',
      right: { glyphs: ['house'] },
    },
    {
      left: { glyphs: ['business'], label: 'Companies' },
      link: 'to',
      carry: 'water',
      right: { glyphs: ['house'] },
      stamp: { glyph: 'seal', label: 'State' },
    },
  ],
  [
    {
      left: { glyphs: ['coins'], label: 'Set aside' },
      link: 'equals',
      right: { glyphs: ['money'], label: 'Cost' },
    },
    {
      left: { glyphs: ['calendar'], label: 'Every year' },
      link: 'to',
      carry: 'document',
      right: { glyphs: ['government'], label: 'State' },
    },
  ],
  [
    {
      left: { glyphs: ['water', 'calendar'], label: 'Ten years' },
      link: 'none',
      stamp: { glyph: 'clock' },
    },
    {
      left: { glyphs: ['business'], label: 'Late' },
      link: 'to',
      carry: 'money',
      right: { glyphs: ['government'], label: '$1,000' },
    },
  ],
];

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    // A zero-delay stream should not accumulate one scheduled timer per word in tests.
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(abortError());
      },
      { once: true },
    );
  });

/** A URL containing "charter" ingests as a scanned local charter amendment (demo only). */
const CHARTER_URL = /charter/i;
const CHARTER_SCAN: ScanStatus = {
  pages: [
    { page: 1, marks: 'read' },
    { page: 2, marks: 'not-read' },
    { page: 3, marks: 'uncertain' },
  ],
};

const abortError = () => new DOMException('Aborted', 'AbortError');

/** A stable 64-hex id derived from the URL so re-ingesting the same URL is detected as a reuse. */
function docIdFor(url: string): string {
  let hash = 5381;
  for (const ch of url) hash = Math.imul(hash, 33) ^ ch.charCodeAt(0);
  let out = '';
  for (let i = 0; out.length < 64; i++) {
    hash = Math.imul(hash, 16777619) ^ (i + 1);
    out += (hash >>> 0).toString(16).padStart(8, '0');
  }
  return out;
}

function formatFor(url: string): DocSummary['format'] {
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.xml')) return 'xml';
  if (path.endsWith('.htm') || path.endsWith('.html')) return 'html';
  if (path.endsWith('.txt')) return 'text';
  return 'pdf';
}

export function createMockApi(options: MockApiOptions = {}): ApiClient {
  const delay = options.delayMs ?? 350;
  const publicMode = options.publicMode ?? false;
  const docs = new Map<string, DocSummary>([[SAMPLE_ID, SAMPLE_DOC]]);
  const summariesStarted = new Set<string>();
  // How many times each breakdown / example has been looked at, so a poll sees it progress.
  const breakdownLooks = new Map<string, number>();
  const summaryPictureLooks = new Map<string, number>();
  const breakdownPictureLooks = new Map<string, number>();
  const exampleLooks = new Map<string, number>();

  const config: ClientConfig = {
    productName: BRAND.displayName,
    publicMode,
    freeformEnabled: !publicMode,
    backend: 'local',
    provider: 'mock',
    model: 'mock-1',
    chips: CHIPS,
    scenariosEnabled: !publicMode,
    breakdownEnabled: !publicMode,
    locateEnabled: !publicMode,
    examples: [
      { label: 'Clean Water Infrastructure Act', url: SAMPLE_DOC.sourceUrl },
      {
        label: 'A second sample bill',
        url: 'https://example.gov/bills/sb77.pdf',
      },
      {
        label: 'A web page of links',
        url: 'https://example.gov/bills/wrapper',
      },
    ],
  };

  const need = (docId: string): DocSummary => {
    const doc = docs.get(docId);
    if (!doc)
      throw new ApiError('DOC_NOT_FOUND', 'That document has not been loaded.');
    return doc;
  };
  const hasLines = (doc: DocSummary) => doc.format === 'pdf';

  const excerptFor = (doc: DocSummary, s: MockSection): SectionExcerpt => ({
    sectionId: s.id,
    breadcrumb: s.breadcrumb,
    num: s.num,
    heading: s.heading,
    spans: s.spans,
    location: hasLines(doc)
      ? {
          pageStart: s.page,
          pageEnd: s.page,
          lineStart: s.lines[0],
          lineEnd: s.lines[1],
        }
      : {},
  });

  function buildAnswer(
    doc: DocSummary,
    text: string,
    declined: boolean,
  ): AnswerResult {
    const ids = [...new Set(findCitationIds(text))];
    return {
      text,
      citations: ids.flatMap((id) => {
        const s = SECTIONS.find((x) => x.id === id);
        if (!s) return [];
        const e = excerptFor(doc, s);
        return [
          {
            sectionId: id,
            valid: true,
            chunkIds: [`${id}#0`],
            breadcrumb: s.breadcrumb,
            location: e.location,
          },
        ];
      }),
      invalidCitations: [],
      warnings: [],
      declined,
      readingGrade: 7.4,
      provider: 'mock',
      model: 'mock-1',
      usage: { inputTokens: 900, outputTokens: 120 },
    };
  }

  return {
    mock: true,
    async locate(docId, req, signal) {
      need(docId);
      await sleep(delay, signal);
      if (publicMode)
        return {
          status: 'disabled',
          matches: [],
          provider: 'mock',
          model: 'mock-1',
        };
      if (/not found|space|unicorn/i.test(req.text))
        return {
          status: 'not-found',
          matches: [],
          provider: 'mock',
          model: 'mock-1',
          note: 'The bill sets a deadline for replacing lead pipes [S:sec-4/b].',
          noteCitations: buildAnswer(need(docId), '[S:sec-4/b]', false)
            .citations,
        };
      return {
        status: 'found',
        provider: 'mock',
        model: 'mock-1',
        readingGrade: 7,
        matches: [
          {
            sectionId: 'sec-4/b',
            breadcrumb: SECTIONS[2]?.breadcrumb ?? 'Section 4(b)',
            quote: [{ text: 'within fifteen years', status: 'deleted' }],
            label: 'removed',
            explanation:
              'The bill removes the fifteen-year deadline [S:sec-4/b].',
            citations: buildAnswer(need(docId), '[S:sec-4/b]', false).citations,
            location: { pageStart: 3, lineStart: 5, lineEnd: 12 },
          },
          {
            sectionId: 'sec-6',
            breadcrumb: SECTIONS[3]?.breadcrumb ?? 'Section 6',
            quote: SECTIONS[3]?.spans ?? [],
            label: 'existing',
            explanation:
              'The bill keeps the daily fine for a late utility [S:sec-6].',
            citations: buildAnswer(need(docId), '[S:sec-6]', false).citations,
            location: { pageStart: 4, lineStart: 1, lineEnd: 3 },
          },
        ],
      };
    },
    async locateVersions(docId, _req, signal) {
      need(docId);
      await sleep(delay, signal);
      return {
        status: publicMode ? 'disabled' : 'ok',
        versions: publicMode
          ? []
          : SAMPLE_HISTORY.versions.flatMap((v) =>
              v.url
                ? [
                    {
                      label: v.label,
                      ...(v.date ? { date: v.date } : {}),
                      url: v.url,
                      overlap: 0.8,
                      excerpt:
                        'A utility shall replace each lead service line within fifteen years.',
                    },
                  ]
                : [],
            ),
      };
    },
    getConfig: () => Promise.resolve(config),
    listDocs: () => Promise.resolve([...docs.values()]),

    // async so a missing document rejects instead of throwing synchronously
    // eslint-disable-next-line @typescript-eslint/require-await
    async getDoc(docId) {
      const doc = need(docId);
      const sample = doc.docId === SAMPLE_ID;
      const charter = CHARTER_URL.test(doc.sourceUrl);
      const detail: DocDetail = {
        doc,
        metadata: charter
          ? {
              title: doc.title,
              billNumber: 'Issue 8',
              jurisdiction: 'City of Columbus, Ohio',
              session: null,
              version: null,
              sponsors: null,
              docKind: 'charter_amendment',
              amends: {
                name: 'Columbus City Charter',
                sections: ['3', '4', '41-5', '46', '46-3'],
              },
              source: 'extracted',
            }
          : sample
            ? {
                title: doc.title,
                billNumber: doc.billNumber,
                jurisdiction: 'Example State',
                session: '2025-2026 Regular Session',
                version: 'As Introduced',
                sponsors: ['Rep. A. Rivera', 'Rep. J. Chen'],
                sponsorProfiles: structuredClone(SAMPLE_SPONSORS),
                source: 'structured',
              }
            : {
                title: doc.title,
                billNumber: null,
                jurisdiction: null,
                session: null,
                version: null,
                sponsors: null,
                source: 'extracted',
              },
        outline: SECTIONS.map((s, i) => ({
          id: s.id,
          // The charter's first two sections stand in for charter sections 3 and 4.
          num: charter && i < 2 ? String(i + 3) : s.num,
          heading: s.heading,
          level: 1,
        })),
        externalRefs: [
          {
            text: 'section 1412 of the federal Safe Drinking Water Act',
            citation: '42 U.S.C. 300g-1',
            kind: 'us_code',
            sectionIds: ['sec-4/b'],
          },
          {
            text: 'section 6111.03 of the Revised Code',
            citation: 'R.C. 6111.03',
            kind: 'state_code',
            sectionIds: ['sec-2/a', 'sec-6'],
          },
        ],
        ...(charter ? { scan: structuredClone(CHARTER_SCAN) } : {}),
        warnings: charter
          ? [
              'Page 2 of this scan could not be read, so changes marked there are missing.',
              'Line numbers were not found on page 3; citations there use the page only.',
            ]
          : hasLines(doc)
            ? []
            : [
                'This file has no printed line numbers, so citations point to a section only.',
              ],
        hasLineNumbers: hasLines(doc),
        ...(sample ? { history: structuredClone(SAMPLE_HISTORY) } : {}),
        ...(sample
          ? {
              historyLinks: {
                actions:
                  'https://www.congress.gov/bill/119th-congress/house-bill/214/all-actions',
                amendments:
                  'https://www.congress.gov/bill/119th-congress/house-bill/214/amendments',
              },
            }
          : {}),
        ...(sample ? { scenarioPersonas: [...SAMPLE_PERSONAS] } : {}),
        preview: sample
          ? {
              kind: 'purpose',
              text: 'To require water utilities to replace lead service lines and to set fines for missing the deadline.',
              sectionId: 'sec-1',
            }
          : { kind: 'title', text: doc.title ?? doc.label },
      };
      return detail;
    },

    // Same contract as GET /api/docs/:id/summary: `pending` on the first look (the server has
    // started the run), then the cached answer, with its scenario. A public server only ever
    // serves what was warmed, so there it is the sample's summary or `disabled`.
    // eslint-disable-next-line @typescript-eslint/require-await
    async getSummary(docId): Promise<SummaryResponse> {
      const doc = need(docId);
      const cached = (): SummaryResponse => ({
        status: 'cached',
        answer: {
          ...buildAnswer(
            doc,
            CHARTER_URL.test(doc.sourceUrl) ? CHARTER_SUMMARY : ANSWERS.summary,
            false,
          ),
          scenario: structuredClone(SAMPLE_SCENARIO),
        },
      });
      if (publicMode)
        return docId === SAMPLE_ID ? cached() : { status: 'disabled' };
      if (summariesStarted.has(docId)) return cached();
      summariesStarted.add(docId);
      return { status: 'pending' };
    },

    // Same contract as GET /api/docs/:id/summary/pictures: pending on the first look, then the
    // drawings for the sample summary's bullets (none for the charter's, which has no list).
    // eslint-disable-next-line @typescript-eslint/require-await
    async getSummaryPictures(docId): Promise<PicturesResponse> {
      const doc = need(docId);
      if (CHARTER_URL.test(doc.sourceUrl)) return { status: 'none' };
      const looks = (summaryPictureLooks.get(docId) ?? 0) + 1;
      summaryPictureLooks.set(docId, looks);
      if (looks === 1 && !publicMode) return { status: 'pending' };
      if (publicMode && docId !== SAMPLE_ID) return { status: 'disabled' };
      const entries = listItems(ANSWERS.summary).flatMap(({ index, text }) => {
        const panels = SUMMARY_PICTURE_PANELS[index];
        return panels
          ? [{ item: index, text, panels: structuredClone(panels) }]
          : [];
      });
      return { status: 'cached', entries };
    },

    // Same contract as GET /api/docs/:id/breakdown/pictures: one picture per sample brief.
    // eslint-disable-next-line @typescript-eslint/require-await
    async getBreakdownPictures(docId): Promise<PicturesResponse> {
      need(docId);
      if (publicMode) return { status: 'disabled' };
      const looks = (breakdownPictureLooks.get(docId) ?? 0) + 1;
      breakdownPictureLooks.set(docId, looks);
      if (looks === 1) return { status: 'pending' };
      const entries: PictureEntry[] = SAMPLE_BRIEFS.flatMap((b, item) => {
        const panels = BRIEF_PICTURE_PANELS[b.sectionId];
        return panels
          ? [
              {
                item,
                text: b.text,
                sectionId: b.sectionId,
                panels: structuredClone(panels),
              },
            ]
          : [];
      });
      return { status: 'cached', entries };
    },

    // Same contract as GET /api/docs/:id/breakdown: pending, then one part finished, then all.
    // eslint-disable-next-line @typescript-eslint/require-await
    async getBreakdown(docId): Promise<BreakdownResponse> {
      const doc = need(docId);
      if (publicMode) return { status: 'disabled' };
      const looks = (breakdownLooks.get(docId) ?? 0) + 1;
      breakdownLooks.set(docId, looks);
      const briefs = (count: number): SectionBrief[] =>
        SAMPLE_BRIEFS.slice(0, count).map((b) => {
          const answer = buildAnswer(doc, b.text, false);
          const section = SECTIONS.find((x) => x.id === b.sectionId);
          return {
            sectionId: b.sectionId,
            ...(section ? { num: section.num, heading: section.heading } : {}),
            text: answer.text,
            citations: answer.citations,
            readingGrade: 6.2,
            example: b.example,
          };
        });
      if (looks === 1) return { status: 'pending' };
      if (looks === 2) return { status: 'pending', briefs: briefs(1) };
      return {
        status: 'cached',
        briefs: briefs(SAMPLE_BRIEFS.length),
        omitted: 0,
      };
    },

    // Same contract as GET /api/docs/:id/sections/:sectionId/example: pending, then the example.
    async getSectionExample(docId, sectionId): Promise<ScenarioResponse> {
      need(docId);
      if (publicMode) return { status: 'disabled' };
      const brief = SAMPLE_BRIEFS.find((b) => b.sectionId === sectionId);
      if (!brief)
        throw new ApiError(
          'INVALID_INPUT',
          'That part of the bill could not be found.',
        );
      if (brief.example === 'none')
        return { status: 'none', note: NO_EXAMPLE_NOTE };
      const key = `${docId}:${sectionId}`;
      const looks = (exampleLooks.get(key) ?? 0) + 1;
      exampleLooks.set(key, looks);
      await sleep(delay);
      if (looks === 1) return { status: 'pending' };
      const scenario = structuredClone(SAMPLE_SCENARIO);
      for (const frame of scenario.frames)
        if (frame.kind !== 'setup') frame.citations = [sectionId];
      return { status: 'ok', scenario };
    },

    // Same contract as POST /api/docs/:id/scenario. Scripted: a judging subject is refused the way
    // the server refuses it, "none" shows the no-result state, anything else gets the sample story.
    async getScenario(docId, req: ScenarioRequest): Promise<ScenarioResponse> {
      need(docId);
      if (publicMode) return { status: 'disabled' };
      await sleep(delay);
      const subject = req.subject.trim().replace(/\s+/g, ' ');
      if (
        !/^[\p{L}\p{N} '\-,.()/&]+$/u.test(subject) ||
        MOCK_JUDGING.test(subject)
      )
        throw new ApiError(
          'INVALID_INPUT',
          'Describe who the example is about in neutral words, without judging the bill.',
        );
      if (/\bnobody\b/i.test(subject)) return { status: 'none' };
      const scenario = structuredClone(SAMPLE_SCENARIO);
      return { status: 'ok', scenario };
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async removeDoc(docId) {
      need(docId);
      docs.delete(docId);
    },

    // eslint-disable-next-line @typescript-eslint/require-await
    async getSection(docId, sectionId) {
      const doc = need(docId);
      const s = SECTIONS.find((x) => x.id === sectionId);
      if (!s) {
        throw new ApiError('DOC_NOT_FOUND', 'That section could not be found.');
      }
      return excerptFor(doc, s);
    },

    async *ingest(
      req: IngestRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<IngestEvent> {
      const url = req.url;
      const wait = () => sleep(delay, signal);

      yield { type: 'progress', stage: 'fetching', detail: url };
      await wait();

      if (/fail/i.test(url)) {
        yield {
          type: 'error',
          error: {
            code: 'FETCH_FAILED',
            message: 'The document could not be downloaded.',
          },
        };
        return;
      }
      if (/wrapper/i.test(url)) {
        yield {
          type: 'candidates',
          links: [
            {
              url: 'https://example.gov/bills/hb214.pdf',
              text: 'Introduced bill (PDF)',
              format: 'pdf',
            },
            {
              url: 'https://example.gov/bills/hb214.xml',
              text: 'Bill text (XML)',
              format: 'xml',
            },
            {
              url: 'https://example.gov/bills/hb214-analysis',
              text: 'Fiscal analysis',
              format: 'unknown',
            },
          ],
        };
        return;
      }

      for (const stage of ['parsing', 'enriching', 'chunking'] as const) {
        yield { type: 'progress', stage };
        await wait();
      }
      for (const done of [0, 20, 40]) {
        yield { type: 'progress', stage: 'embedding', done, total: 40 };
        await wait();
      }
      yield { type: 'progress', stage: 'done' };

      const id = docIdFor(url);
      const reused = docs.has(id) || url === SAMPLE_DOC.sourceUrl;
      const existing = url === SAMPLE_DOC.sourceUrl ? SAMPLE_DOC : docs.get(id);
      const doc: DocSummary = existing ?? {
        docId: id,
        label:
          req.label ?? new URL(url).pathname.split('/').pop() ?? 'Document',
        sourceUrl: url,
        format: formatFor(url),
        title: CHARTER_URL.test(url)
          ? 'Issue 8: Charter amendments'
          : 'Clean Water Infrastructure Act (copy)',
        billNumber: null,
        ingestedAt: NOW,
        lastUsedAt: NOW,
        backend: 'local',
      };
      docs.set(doc.docId, doc);
      yield {
        type: 'done',
        doc,
        stats: {
          format: doc.format,
          sectionCount: SECTIONS.length,
          chunkCountsByType: {
            definition: 2,
            operative: 4,
            findings: 0,
            appropriation: 0,
            penalty: 1,
            effective_date: 1,
            other: 0,
          },
          insertedSpanCount: 1,
          deletedSpanCount: 2,
          externalRefCount: 2,
          embedTokens: reused ? 0 : 4200,
          reused,
        },
      };
    },

    async *ask(
      docId: string,
      req: AskRequest,
      signal?: AbortSignal,
    ): AsyncGenerator<AskEvent> {
      const doc = need(docId);
      if (req.question !== undefined && publicMode) {
        yield {
          type: 'error',
          error: {
            code: 'PUBLIC_MODE_FORBIDDEN',
            message: 'That action is turned off on this public server.',
          },
        };
        return;
      }
      const declined =
        req.question !== undefined && /moon|recipe|weather/i.test(req.question);
      const text = declined
        ? DECLINE_TEXT
        : req.chipId
          ? ANSWERS[req.chipId]
          : ANSWERS.penalties;

      if (
        req.chipId !== 'sponsors' &&
        req.chipId !== 'history' &&
        req.chipId !== 'delegations'
      ) {
        await sleep(delay, signal);
        yield {
          type: 'retrieval',
          mode: 'hybrid_rerank',
          latencyMs: 120,
          refs: findCitationIds(text).map((id) => ({
            chunkId: `${id}#0`,
            sectionId: id,
            breadcrumb: SECTIONS.find((s) => s.id === id)?.breadcrumb ?? id,
            score: 0.8,
            injectedDefinition: false,
          })),
        };
      }
      for (const piece of text.match(/\S+\s*/g) ?? []) {
        await sleep(delay / 5, signal);
        yield { type: 'token', text: piece };
      }
      const answer = buildAnswer(doc, text, declined);
      if (req.chipId === 'money') {
        // Demo of a validation warning: one citation pointed outside the retrieved set.
        answer.warnings = ['INVALID_CITATIONS_REMOVED'];
        answer.invalidCitations = ['sec-99'];
      }
      yield { type: 'done', answer };
      if (req.chipId === 'who-affected' && !declined && !publicMode) {
        // Same order as the real server: the scenario arrives after `done`.
        await sleep(delay, signal);
        yield { type: 'scenario', scenario: structuredClone(SAMPLE_SCENARIO) };
      }
    },
  };
}
