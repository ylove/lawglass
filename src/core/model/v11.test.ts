// v1.1 contract additions (#272). Every change is additive: v1.0 documents, answers and configs
// still parse, and the new shapes accept what the v1.1 features will send.
import { describe, expect, it } from 'vitest';
import {
  AnswerResult,
  BreakdownResponse,
  ClientConfig,
  ExternalRef,
  messageText,
  NormalizedDoc,
  ReferenceText,
  ScenarioResponse,
  SectionExcerpt,
} from './index.js';

const v10Answer = {
  text: 'The fee is $50 [S:sec-4].',
  citations: [{ sectionId: 'sec-4', valid: true, chunkIds: ['c1'] }],
  invalidCitations: [],
  warnings: [],
  declined: false,
  readingGrade: 6.2,
  provider: 'anthropic',
  model: 'claude-sonnet-5-5',
  usage: { inputTokens: 10, outputTokens: 5 },
};

const v10Config = {
  productName: 'x',
  publicMode: false,
  freeformEnabled: true,
  backend: 'local',
  provider: 'anthropic',
  model: 'm',
  chips: [],
  scenariosEnabled: true,
};

const reference = {
  sectionId: 'ref:usc/15/6809',
  citation: '15 U.S.C. 6809',
  heading: '§6809. Definitions',
  sourceUrl:
    'https://uscode.house.gov/view.xhtml?req=granuleid:USC-prelim-title15-section6809',
  text: 'The term "financial institution" means any institution ...',
  terms: ['financial institution'],
  fetchedAt: '2026-10-26T00:00:00.000Z',
};

describe('v1.1 contracts', () => {
  it('still parses v1.0 answers and configs, with the new fields absent or defaulted', () => {
    const answer = AnswerResult.parse(v10Answer);
    expect(answer.context).toBeUndefined();
    expect(answer.simplified).toBeUndefined();
    const config = ClientConfig.parse(v10Config);
    expect(config.breakdownEnabled).toBe(false);
    expect(config.library).toBeUndefined();
  });

  it('keeps cache token counts and the context on an answer', () => {
    const answer = AnswerResult.parse({
      ...v10Answer,
      usage: { ...v10Answer.usage, cacheReadTokens: 8 },
      context: 'whole',
      simplified: true,
    });
    expect(answer.usage.cacheReadTokens).toBe(8);
    expect(answer.context).toBe('whole');
  });

  it('accepts reference text only under the reserved id prefix', () => {
    expect(ReferenceText.parse(reference).terms).toEqual([
      'financial institution',
    ]);
    expect(
      ReferenceText.safeParse({ ...reference, sectionId: 'sec-1' }).success,
    ).toBe(false);
    expect(
      ExternalRef.parse({
        text: '15 U.S.C. 6809',
        citation: '15 U.S.C. 6809',
        kind: 'us_code',
        sectionIds: ['sec-2'],
        referenceId: reference.sectionId,
      }).referenceId,
    ).toBe('ref:usc/15/6809');
  });

  it('parses a v1.0 document with no references, and one with them', () => {
    const doc = {
      docId: 'a'.repeat(64),
      sourceUrl: 'https://www.govinfo.gov/x.xml',
      format: 'xml',
      fetchedAt: '2026-10-21T00:00:00.000Z',
      metadata: {
        title: null,
        billNumber: null,
        jurisdiction: null,
        session: null,
        version: null,
        sponsors: null,
        source: 'none',
      },
      sections: [],
      definitions: [],
      externalRefs: [],
      warnings: [],
    };
    expect(NormalizedDoc.parse(doc).references).toBeUndefined();
    expect(
      NormalizedDoc.parse({ ...doc, references: [reference] }).references,
    ).toHaveLength(1);
  });

  it('describes per-section examples, the breakdown and reference excerpts', () => {
    expect(ScenarioResponse.parse({ status: 'pending' }).status).toBe(
      'pending',
    );
    expect(
      ScenarioResponse.parse({ status: 'none', note: 'No one-person example.' })
        .note,
    ).toBe('No one-person example.');
    const breakdown = BreakdownResponse.parse({
      status: 'cached',
      briefs: [
        {
          sectionId: 'sec-3',
          num: '3',
          heading: 'Grants',
          text: 'It sets up grants [S:sec-3].',
          citations: [{ sectionId: 'sec-3', valid: true, chunkIds: [] }],
          readingGrade: 5,
          example: 'available',
        },
      ],
      omitted: 0,
    });
    expect(breakdown.briefs?.[0]?.example).toBe('available');
    expect(
      SectionExcerpt.parse({
        sectionId: reference.sectionId,
        breadcrumb: '15 U.S.C. 6809',
        spans: [{ text: reference.text, status: 'unchanged' }],
        location: {},
        reference: { citation: reference.citation, url: reference.sourceUrl },
      }).reference?.citation,
    ).toBe('15 U.S.C. 6809');
  });

  it('caps the homepage examples and names the library scope', () => {
    const config = ClientConfig.parse({
      ...v10Config,
      library: 'reader',
      examples: [{ label: 'S. 1582', url: 'https://www.congress.gov/x' }],
    });
    expect(config.library).toBe('reader');
    expect(
      ClientConfig.safeParse({
        ...v10Config,
        examples: Array.from({ length: 7 }, () => ({
          label: 'x',
          url: 'https://www.congress.gov/x',
        })),
      }).success,
    ).toBe(false);
  });

  it('joins message parts in order', () => {
    expect(messageText('plain')).toBe('plain');
    expect(messageText([{ text: 'a', cache: true }, { text: 'b' }])).toBe('ab');
  });
});
