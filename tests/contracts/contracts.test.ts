/**
 * Runs the shared contract suites against the test doubles (proves the suites themselves are
 * sound), plus schema-level checks on the frozen contracts.
 */
import { describe, expect, it } from 'vitest';
import {
  AskRequest,
  CITATION_PATTERN,
  Chunk,
  GoldenQuestion,
  IngestEvent,
  NormalizedDoc,
  Section,
  sectionText,
  walkSections,
  AppError,
  ERROR_CODES,
  ZERO_USAGE,
  addUsage,
  isAppError,
  findCitationIds,
  SectionId,
} from '../../src/core/model/index.js';
import { describeBackendContract } from './backend.contract.js';
import { describeProviderContract } from './provider.contract.js';
import { MemoryBackend } from './memory-backend.js';
import { CHUNKS_A } from './sample-chunks.js';
import { ScriptedProvider } from './scripted-provider.js';

describeBackendContract('memory double', () =>
  Promise.resolve({ backend: new MemoryBackend() }),
);

describeProviderContract(
  'scripted double',
  () =>
    new ScriptedProvider({
      objects: {
        bill_fields: { billNumber: 'S. 202', sponsors: ['Senator Example'] },
      },
    }),
);

const tree: Section = {
  id: 'sec-1',
  num: '1',
  level: 1,
  spans: [
    { text: 'Keep this. ', status: 'unchanged' },
    { text: 'Old words. ', status: 'deleted', page: 2, line: 14 },
    { text: 'New words.', status: 'inserted' },
  ],
  children: [
    {
      id: 'sec-1/a',
      num: '(a)',
      level: 2,
      spans: [],
      children: [{ id: 'sec-1/a/1', level: 3, spans: [], children: [] }],
    },
  ],
};

describe('model contracts', () => {
  it('walks sections depth-first', () => {
    expect([...walkSections([tree])].map((s) => s.id)).toEqual([
      'sec-1',
      'sec-1/a',
      'sec-1/a/1',
    ]);
  });

  it('excludes struck text unless asked', () => {
    expect(sectionText(tree, { includeDeleted: false })).toBe(
      'Keep this. New words.',
    );
    expect(sectionText(tree, { includeDeleted: true })).toBe(
      'Keep this. Old words. New words.',
    );
  });

  it('validates a NormalizedDoc with a recursive section tree', () => {
    const doc = {
      docId: 'c'.repeat(64),
      sourceUrl: 'https://example.gov/bill.xml',
      format: 'xml',
      fetchedAt: '2026-10-13T00:00:00.000Z',
      metadata: {
        title: null,
        billNumber: 'S. 1',
        jurisdiction: null,
        session: null,
        version: null,
        sponsors: null,
        source: 'structured',
      },
      sections: [tree],
      definitions: [],
      externalRefs: [],
      warnings: [],
    };
    expect(NormalizedDoc.safeParse(doc).success).toBe(true);
    expect(
      NormalizedDoc.safeParse({ ...doc, docId: 'not-a-hash' }).success,
    ).toBe(false);
  });

  it('validates sample chunks', () => {
    for (const c of CHUNKS_A) expect(Chunk.safeParse(c).success).toBe(true);
  });

  it('finds citation markers', () => {
    const ids = [
      ...'Grants go to towns [S:sec-3] defined in [S:sec-2/a].'.matchAll(
        CITATION_PATTERN,
      ),
    ].map((m) => m[1]);
    expect(ids).toEqual(['sec-3', 'sec-2/a']);
  });

  it('requires exactly one of chipId or question', () => {
    expect(AskRequest.safeParse({ chipId: 'summary' }).success).toBe(true);
    expect(AskRequest.safeParse({ question: 'Who pays?' }).success).toBe(true);
    expect(AskRequest.safeParse({}).success).toBe(false);
    expect(
      AskRequest.safeParse({ chipId: 'summary', question: 'Who pays?' })
        .success,
    ).toBe(false);
  });

  it('discriminates SSE events', () => {
    expect(
      IngestEvent.safeParse({ type: 'progress', stage: 'parsing' }).success,
    ).toBe(true);
    expect(
      IngestEvent.safeParse({ type: 'progress', stage: 'teleporting' }).success,
    ).toBe(false);
  });

  it('requires unanswerable golden questions to have no expected sections', () => {
    expect(
      GoldenQuestion.safeParse({
        id: 'q1',
        question: 'x',
        kind: 'unanswerable',
        expectedSectionIds: [],
      }).success,
    ).toBe(true);
    expect(
      GoldenQuestion.safeParse({
        id: 'q2',
        question: 'x',
        kind: 'exact',
        expectedSectionIds: [],
      }).success,
    ).toBe(false);
  });

  it('gives every error code a plain-language user message', () => {
    const e = new AppError('SCANNED_PDF');
    expect(e.userMessage).toBe(
      "This PDF appears to be scanned; OCR isn't supported yet.",
    );
    for (const msg of Object.values(ERROR_CODES)) expect(msg).toMatch(/[.!?]$/);
  });

  it('adds usage field by field', () => {
    const u = { embedTokens: 3, rerankUnits: 1, readUnits: 2, writeUnits: 5 };
    expect(addUsage(u, u)).toEqual({
      embedTokens: 6,
      rerankUnits: 2,
      readUnits: 4,
      writeUnits: 10,
    });
    expect(addUsage(ZERO_USAGE, u)).toEqual(u);
  });

  it('recognizes AppError instances only', () => {
    expect(isAppError(new AppError('DOC_NOT_FOUND'))).toBe(true);
    expect(isAppError(new Error('plain'))).toBe(false);
  });

  it('only accepts citation-safe section ids, everywhere a section id appears', () => {
    expect(SectionId.safeParse('sec-5747.01/a/1').success).toBe(true);
    for (const bad of ['', 'sec 1', 'sec-1]', '[sec-1', 'sec-1\n']) {
      expect(SectionId.safeParse(bad).success).toBe(false);
    }
    const bad = { ...CHUNKS_A[0], sectionId: 'sec 1]' };
    expect(Chunk.safeParse(bad).success).toBe(false);
  });

  it('findCitationIds is stateless across calls', () => {
    const text = 'A [S:sec-1] and B [S:sec-2/a].';
    expect(findCitationIds(text)).toEqual(['sec-1', 'sec-2/a']);
    expect(findCitationIds(text)).toEqual(['sec-1', 'sec-2/a']);
    expect(findCitationIds('no citations')).toEqual([]);
  });
});
