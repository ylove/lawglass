// Scripted in-browser stand-in for the server, enabled with `?mock=1` (or VITE_MOCK_API).
// It speaks the same contracts as the real API, so the whole UI can be demoed and tested
// without a server. All content is invented; it is not real legislation.
import {
  findCitationIds,
  DECLINE_TEXT,
  type AnswerResult,
  type AskEvent,
  type AskRequest,
  type ChipId,
  type ClientConfig,
  type DocDetail,
  type DocSummary,
  type IngestEvent,
  type IngestRequest,
  type Scenario,
  type SectionExcerpt,
} from '../core/model/index.js';
import { BRAND } from '../core/brand.js';
import type { ApiClient } from './api.js';
import { ApiError } from './sse.js';

export interface MockApiOptions {
  /** Delay between scripted events. Tests pass 0. */
  delayMs?: number;
  /** Simulates a public server: no freeform questions. */
  publicMode?: boolean;
}

export const MOCK_HINT =
  'Demo mode. Any web address works. Try one containing "wrapper" to see the file picker, "fail" to see an error, or ending in .xml for a document without page and line numbers.';

const CHIPS: ClientConfig['chips'] = [
  { id: 'summary', label: 'Summarize this bill' },
  { id: 'what-changes', label: 'What does it change?' },
  { id: 'who-affected', label: 'Who does it affect?' },
  { id: 'history', label: 'How did it get here?' },
  { id: 'penalties', label: 'Penalties and enforcement' },
  { id: 'effective-date', label: 'When does it take effect?' },
  { id: 'money', label: 'Taxes, fees, and spending' },
  { id: 'definitions', label: 'Key definitions' },
  { id: 'sponsors', label: 'Who sponsored it?' },
];

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

const ANSWERS: Record<ChipId, string> = {
  summary:
    'This bill requires water utilities to replace lead pipes and sets fines for missing the deadline [S:sec-4/b]. It takes effect on July 1, 2027 [S:sec-7].\n\nIt also defines the key terms it uses, such as "public water system" and "utility" [S:sec-2/a].',
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

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
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

  const config: ClientConfig = {
    productName: BRAND.displayName,
    publicMode,
    freeformEnabled: !publicMode,
    backend: 'local',
    provider: 'mock',
    model: 'mock-1',
    chips: CHIPS,
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
    getConfig: () => Promise.resolve(config),
    listDocs: () => Promise.resolve([...docs.values()]),

    // async so a missing document rejects instead of throwing synchronously
    // eslint-disable-next-line @typescript-eslint/require-await
    async getDoc(docId) {
      const doc = need(docId);
      const sample = doc.docId === SAMPLE_ID;
      const detail: DocDetail = {
        doc,
        metadata: sample
          ? {
              title: doc.title,
              billNumber: doc.billNumber,
              jurisdiction: 'Example State',
              session: '2025-2026 Regular Session',
              version: 'As Introduced',
              sponsors: ['Rep. A. Rivera', 'Rep. J. Chen'],
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
        outline: SECTIONS.map((s) => ({
          id: s.id,
          num: s.num,
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
        warnings: hasLines(doc)
          ? []
          : [
              'This file has no printed line numbers, so citations point to a section only.',
            ],
        hasLineNumbers: hasLines(doc),
      };
      return detail;
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
        title: 'Clean Water Infrastructure Act (copy)',
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

      if (req.chipId !== 'sponsors' && req.chipId !== 'history') {
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
