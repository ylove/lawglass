import { describe, expect, it } from 'vitest';
import type { ExternalRef, ReferenceText } from '../model/index.js';
import {
  buildUnitContext,
  MAX_RELATED_SECTIONS,
  UNIT_TOKEN_BUDGET,
  unitExcerpts,
} from './context.js';
import { chunkHit, DOC_ID, fakeBackend, sec } from './test-support.js';

const grants = sec('sec-2', 'Grants', 'Grants go to each eligible town.', [
  sec('sec-2/a', 'Eligibility', 'A town is eligible if it has a garden group.'),
]);
const reports = sec('sec-3', 'Reports', 'Each grantee files a report.');
const defs = sec('sec-9', 'Definitions', 'Terms are defined here.');

const chunks = [
  chunkHit('sec-2', 'Grants go to each eligible town.', {
    definedTermsUsed: ['eligible town'],
    refs: ['sec-3', 'sec-404'],
  }),
  chunkHit('sec-2/a', 'A town is eligible if it has a garden group.'),
  chunkHit('sec-3', 'Each grantee files a report.'),
  chunkHit('sec-9', '"Eligible town" means a town with a garden group.', {
    chunkType: 'definition',
    definesTerm: 'eligible town',
  }),
];
const doc = {
  sections: [grants, reports, defs],
  externalRefs: [],
  references: [],
};

describe('buildUnitContext', () => {
  it('reads a part, its definitions and the section it refers to from a fetched bill', async () => {
    const backend = fakeBackend(chunks);
    const context = await buildUnitContext({
      backend,
      docId: DOC_ID,
      doc,
      unit: grants,
    });
    expect(context.hits.map((h) => h.chunk.sectionId)).toEqual([
      'sec-2',
      'sec-2/a',
    ]);
    expect(context.definitions.map((h) => h.chunk.definesTerm)).toEqual([
      'eligible town',
    ]);
    // One hop, only sections that exist: sec-404 is dropped, and sec-3's own refs are not followed.
    expect(context.related.map((h) => h.chunk.sectionId)).toEqual(['sec-3']);
    expect(unitExcerpts(context)).toHaveLength(4);
  });

  it('reads from the whole-bill pool without touching the backend', async () => {
    const backend = fakeBackend(chunks);
    const context = await buildUnitContext({
      backend,
      docId: DOC_ID,
      doc,
      unit: grants,
      pool: chunks,
    });
    expect(context.hits).toHaveLength(2);
    expect(context.definitions).toHaveLength(1);
    expect(context.related).toHaveLength(1);
    expect(backend.getChunkCalls).toBe(0);
    expect(backend.searchCalls).toBe(0);
  });

  it('never includes struck text', async () => {
    const struck = chunkHit('sec-2', 'Old rule.', {
      amendmentStatus: 'deleted',
    });
    const context = await buildUnitContext({
      backend: fakeBackend([struck, chunks[1]!]),
      docId: DOC_ID,
      doc,
      unit: grants,
    });
    expect(context.hits.map((h) => h.chunk.id)).toEqual([chunks[1]!.chunk.id]);
  });

  it('cuts a very long part at the token budget but always keeps its first passage', async () => {
    const big = Array.from({ length: 5 }, (_, i) =>
      chunkHit(i === 0 ? 'sec-2' : 'sec-2/a', `passage ${String(i)}`, {
        id: `${DOC_ID}:${i === 0 ? 'sec-2' : 'sec-2/a'}:${String(i === 0 ? 0 : i - 1)}`,
        tokenCount: UNIT_TOKEN_BUDGET,
      }),
    );
    const context = await buildUnitContext({
      backend: fakeBackend(big),
      docId: DOC_ID,
      doc,
      unit: grants,
    });
    expect(context.hits).toHaveLength(1);
  });

  it('caps cross-referenced sections', async () => {
    const many = Array.from({ length: MAX_RELATED_SECTIONS + 2 }, (_, i) =>
      sec(`sec-r${String(i)}`, 'Other', 'Other text.'),
    );
    const refs = many.map((s) => s.id);
    const own = chunkHit('sec-2', 'Grants.', { refs });
    const context = await buildUnitContext({
      backend: fakeBackend([
        own,
        ...many.map((s) => chunkHit(s.id, 'Other text.')),
      ]),
      docId: DOC_ID,
      doc: { ...doc, sections: [grants, ...many] },
      unit: sec('sec-2', 'Grants', 'Grants.'),
    });
    expect(context.related).toHaveLength(MAX_RELATED_SECTIONS);
  });

  it('adds other law read for the bill as an excerpt that cites the bill section relying on it', async () => {
    const ref: ExternalRef = {
      text: 'section 6809 of title 15',
      citation: '15 U.S.C. 6809',
      kind: 'us_code',
      sectionIds: ['sec-2/a', 'sec-9'],
      referenceId: 'ref:usc/15/6809',
    };
    const text: ReferenceText = {
      sectionId: 'ref:usc/15/6809',
      citation: '15 U.S.C. 6809',
      heading: 'Definitions',
      sourceUrl: 'https://www.govinfo.gov/x',
      text: 'The term "financial institution" means any institution engaged in financial activities.',
      fetchedAt: '2026-10-01T00:00:00.000Z',
    };
    const context = await buildUnitContext({
      backend: fakeBackend(chunks),
      docId: DOC_ID,
      doc: { ...doc, externalRefs: [ref], references: [text] },
      unit: grants,
    });
    const [excerpt] = context.references;
    expect(excerpt?.chunk.sectionId).toBe('sec-2/a');
    expect(excerpt?.chunk.breadcrumb).toContain('15 U.S.C. 6809');
    expect(excerpt?.chunk.text).toContain('financial institution');
  });

  it('copes with a bill that has no references at all', async () => {
    const context = await buildUnitContext({
      backend: fakeBackend(chunks),
      docId: DOC_ID,
      doc: { sections: doc.sections, externalRefs: [], references: undefined },
      unit: reports,
    });
    expect(context.references).toEqual([]);
  });
});
