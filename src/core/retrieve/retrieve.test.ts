import { beforeAll, describe, expect, it } from 'vitest';
import { MemoryBackend } from '../../../tests/contracts/memory-backend.js';
import { CHUNKS_A, DOC_A } from '../../../tests/contracts/sample-chunks.js';
import {
  ZERO_USAGE,
  makeChunkId,
  type Chunk,
  type RetrievalBackend,
  type SearchRequest,
} from '../model/index.js';
import {
  MAX_INJECTED_DEFINITIONS,
  termsNeedingDefinitions,
} from './definitions.js';
import {
  asksAboutChanges,
  buildFilter,
  HYBRID_CANDIDATES,
  RERANK_MAX_CANDIDATES,
  retrieve,
} from './retrieve.js';

/** Wraps a backend and records every call, so tests can assert on how it was driven. */
function spy(inner: RetrievalBackend) {
  const searches: SearchRequest[] = [];
  const reranks: { topN: number; n: number }[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const backend: RetrievalBackend = {
    kind: inner.kind,
    ensureReady: (s) => inner.ensureReady(s),
    hasDocument: (d) => inner.hasDocument(d),
    upsertChunks: (d, c, p) => inner.upsertChunks(d, c, p),
    getChunks: (d, i) => inner.getChunks(d, i),
    deleteDocument: (d) => inner.deleteDocument(d),
    search: (req) => {
      searches.push(req);
      signals.push(req.signal);
      return inner.search(req);
    },
    rerank: (req) => {
      reranks.push({ topN: req.topN, n: req.hits.length });
      signals.push(req.signal);
      return inner.rerank(req);
    },
  };
  return { backend, searches, reranks, signals };
}

const ids = (r: { hits: { chunk: { id: string } }[] }) =>
  r.hits.map((h) => h.chunk.id);

const REPORTED_CHANGE_QUESTIONS = [
  'What does the bill cross out about the places where a person has no duty to retreat?',
  'What old wording is crossed out where the bill says what "residence" means?',
  "Does the bill get rid of the rule that a jury can't consider…?",
];

let memory: MemoryBackend;
beforeAll(async () => {
  memory = new MemoryBackend();
  await memory.upsertChunks(DOC_A, CHUNKS_A);
});

describe('modes', () => {
  it('dense queries only the dense index with topK', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants eligible town',
      mode: 'dense',
      topK: 3,
    });
    expect(r.mode).toBe('dense');
    expect(
      s.searches.filter((q) => q.index === 'dense').length,
    ).toBeGreaterThanOrEqual(1);
    expect(s.searches.some((q) => q.index === 'sparse')).toBe(false);
    expect(s.searches[0]!.topK).toBe(3);
    expect(r.hits.filter((h) => !h.injected)).toHaveLength(3);
  });

  it('sparse queries only the sparse index and drops zero-match chunks', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'fined per day',
      mode: 'sparse',
    });
    expect(s.searches[0]!.index).toBe('sparse');
    expect(ids(r)).toEqual([makeChunkId(DOC_A, 'sec-4', 0)]);
  });

  it('hybrid fetches 40 from each index, fuses, and does not rerank', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'eligible town grants',
      mode: 'hybrid',
      topK: 4,
    });
    const main = s.searches.slice(0, 2);
    expect(main.map((q) => q.index).sort()).toEqual(['dense', 'sparse']);
    expect(main.every((q) => q.topK === HYBRID_CANDIDATES)).toBe(true);
    expect(s.reranks).toHaveLength(0);
    const ranked = r.hits.filter((h) => !h.injected);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked.length).toBeLessThanOrEqual(4);
    expect(new Set(ids(r)).size).toBe(r.hits.length); // deduped
  });

  it('hybrid_rerank is the default and reranks fused candidates to top 8', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants for water treatment',
    });
    expect(r.mode).toBe('hybrid_rerank');
    expect(s.reranks).toHaveLength(1);
    expect(s.reranks[0]!.topN).toBe(8);
    expect(r.usage.rerankUnits).toBe(1);
    expect(ids(r)[0]).toBe(makeChunkId(DOC_A, 'sec-3', 0));
  });

  it('bounds and dedupes the rerank input', async () => {
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        chunk: {
          id: `${prefix}${String(i)}`,
          definedTermsUsed: [],
          amendmentStatus: 'unchanged',
        } as unknown as never,
        score: n - i,
      }));
    const shared = mk('s', 10);
    const backendFor = (dense: unknown[], sparse: unknown[]) => {
      const reranks: string[][] = [];
      const backend: RetrievalBackend = {
        ...spy(memory).backend,
        search: (req: SearchRequest) =>
          Promise.resolve({
            hits: (req.index === 'dense' ? dense : sparse) as never,
            usage: ZERO_USAGE,
          }),
        rerank: (req) => {
          reranks.push(req.hits.map((h) => h.chunk.id));
          return Promise.resolve({
            hits: req.hits.slice(0, req.topN),
            usage: ZERO_USAGE,
          });
        },
      };
      return { backend, reranks };
    };
    // 40 + 40 disjoint candidates: capped at RERANK_MAX_CANDIDATES.
    const disjoint = backendFor(mk('d', 40), mk('x', 40));
    await retrieve(disjoint.backend, { docId: DOC_A, query: 'q' });
    expect(disjoint.reranks[0]).toHaveLength(RERANK_MAX_CANDIDATES);
    // Overlapping lists: each id reaches the reranker once.
    const overlap = backendFor(shared, shared);
    await retrieve(overlap.backend, { docId: DOC_A, query: 'q' });
    expect(overlap.reranks[0]).toHaveLength(10);
    expect(new Set(overlap.reranks[0]).size).toBe(10);
  });

  it('rerankTopN overrides the rerank size', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'eligible town',
      rerankTopN: 1,
    });
    expect(s.reranks[0]!.topN).toBe(1);
    expect(r.hits.filter((h) => !h.injected)).toHaveLength(1);
  });

  it('skips the rerank call when nothing was found', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: 'missing-doc',
      query: 'anything',
    });
    expect(s.reranks).toHaveLength(0);
    expect(r.hits).toEqual([]);
  });
});

describe('fusion selection', () => {
  /** Backend returning fixed lists per index, to prove which fusion produced the order. */
  const scripted = (): RetrievalBackend => {
    const stored = (id: string) =>
      ({
        id,
        definedTermsUsed: [],
        amendmentStatus: 'unchanged',
      }) as unknown as Chunk;
    const lists = {
      dense: [stored('a'), stored('b')],
      sparse: [stored('b'), stored('c')],
    };
    const scores = { dense: [0.99, 0.01], sparse: [100, 1] };
    return {
      ...spy(memory).backend,
      search: (req: SearchRequest) =>
        Promise.resolve({
          hits: lists[req.index].map((chunk, i) => ({
            chunk: chunk as never,
            score: scores[req.index][i]!,
          })),
          usage: ZERO_USAGE,
        }),
    };
  };

  it('uses RRF by default', async () => {
    const r = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
    });
    expect(ids(r)).toEqual(['b', 'a', 'c']);
  });

  it('applies sparseWeight under the default RRF fusion', async () => {
    const run = (sparseWeight?: number) =>
      retrieve(scripted(), {
        docId: DOC_A,
        query: 'q',
        mode: 'hybrid',
        sparseWeight,
      });
    expect(ids(await run(0.5))).toEqual(ids(await run(undefined)));
    expect(ids(await run(1))[0]).toBe('b'); // sparse #1
    expect(ids(await run(0))).toEqual(['a', 'b', 'c']);
    const sparseOnlyTop = await retrieve(
      {
        ...scripted(),
        search: (req: SearchRequest) =>
          Promise.resolve({
            hits: (req.index === 'dense'
              ? ['a', 'b', 'c']
              : ['c', 'b', 'a']
            ).map((id, i) => ({
              chunk: {
                id,
                definedTermsUsed: [],
                amendmentStatus: 'unchanged',
              } as unknown as never,
              score: 3 - i,
            })),
            usage: ZERO_USAGE,
          }),
      },
      { docId: DOC_A, query: 'q', mode: 'hybrid', sparseWeight: 1 },
    );
    expect(ids(sparseOnlyTop)[0]).toBe('c');
  });

  it('uses weighted min-max when asked, honouring sparseWeight', async () => {
    const dense = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
      fusion: 'weighted',
      sparseWeight: 0,
    });
    expect(ids(dense)).toEqual(['a', 'b', 'c']);
    const sparse = await retrieve(scripted(), {
      docId: DOC_A,
      query: 'q',
      mode: 'hybrid',
      fusion: 'weighted',
      sparseWeight: 1,
    });
    expect(ids(sparse)).toEqual(['b', 'a', 'c']); // a and c tie at 0; a was seen first;
  });
});

describe('deleted spans', () => {
  const deletedId = makeChunkId(DOC_A, 'sec-5', 1);

  it('excludes deleted chunks by default via a backend-side filter', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      mode: 'sparse',
      includeDeleted: false,
    });
    expect(ids(r)).not.toContain(deletedId);
    expect(s.searches[0]!.filter?.amendmentStatus).toEqual([
      'unchanged',
      'inserted',
    ]);
  });

  it('includes them with includeDeleted', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      mode: 'sparse',
      includeDeleted: true,
    });
    expect(ids(r)).toContain(deletedId);
  });

  it('buildFilter merges chip filters and intersects explicit statuses', () => {
    expect(buildFilter(undefined, true)).toBeUndefined();
    expect(buildFilter({ chunkType: ['penalty'] }, false)).toEqual({
      chunkType: ['penalty'],
      amendmentStatus: ['unchanged', 'inserted'],
    });
    expect(buildFilter({ amendmentStatus: ['inserted'] }, false)).toEqual({
      amendmentStatus: ['inserted'],
    });
    expect(buildFilter({ amendmentStatus: ['deleted'] }, true)).toEqual({
      amendmentStatus: ['deleted'],
    });
  });

  it('treats an explicit deleted in the chip filter as the opt-in', () => {
    expect(
      buildFilter({ amendmentStatus: ['inserted', 'deleted'] }, false),
    ).toEqual({ amendmentStatus: ['inserted', 'deleted'] });
    expect(buildFilter({ amendmentStatus: ['deleted'] }, false)).toEqual({
      amendmentStatus: ['deleted'],
    });
  });

  it.each(['hybrid_rerank', 'hybrid', 'dense', 'sparse'] as const)(
    'excludes deleted chunks by default in %s mode',
    async (mode) => {
      const r = await retrieve(memory, {
        docId: DOC_A,
        query: 'Section 5747.01 taxes imposed',
        mode,
        topK: 20,
      });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(ids(r)).not.toContain(deletedId);
      expect(r.hits.every((h) => h.chunk.amendmentStatus !== 'deleted')).toBe(
        true,
      );
    },
  );

  it('what-changes shape (inserted+deleted chip filter) retrieves deleted text in hybrid_rerank', async () => {
    const s = spy(memory);
    const r = await retrieve(s.backend, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      filter: { amendmentStatus: ['inserted', 'deleted'] },
      includeDeleted: true,
      topK: 20,
    });
    expect(ids(r)).toContain(deletedId);
    expect(
      r.hits.every((h) =>
        ['inserted', 'deleted'].includes(h.chunk.amendmentStatus),
      ),
    ).toBe(true);
    // the chip filter alone (no includeDeleted) is enough
    const chipOnly = await retrieve(memory, {
      docId: DOC_A,
      query: 'Section 5747.01 repealed',
      filter: { amendmentStatus: ['inserted', 'deleted'] },
      topK: 20,
    });
    expect(ids(chipOnly)).toContain(deletedId);
  });

  it('derives includeDeleted from the question when left undefined', async () => {
    const q = (query: string, includeDeleted?: boolean) =>
      retrieve(memory, {
        docId: DOC_A,
        query,
        mode: 'sparse',
        topK: 20,
        includeDeleted,
      });
    expect(ids(await q('Section 5747.01 repealed'))).toContain(deletedId);
    expect(ids(await q('Section 5747.01 repealed', false))).not.toContain(
      deletedId,
    );
  });

  it.each(REPORTED_CHANGE_QUESTIONS)(
    'retrieves deleted spans for the reported question: %s',
    async (query) => {
      for (const mode of [
        'dense',
        'sparse',
        'hybrid',
        'hybrid_rerank',
      ] as const) {
        const options = { docId: DOC_A, query, mode, topK: 20 };
        // The shared synthetic deleted chunk overlaps each question ("the"/"of").
        expect(ids(await retrieve(memory, options))).toContain(deletedId);
        expect(
          ids(await retrieve(memory, { ...options, includeDeleted: false })),
        ).not.toContain(deletedId);
      }
    },
  );

  it.each([
    'Does the bill let people take out a loan?',
    'Does the bill help people get rid of pests?',
    'Does the bill let people cross out of state?',
  ])(
    'keeps deleted spans excluded for an unrelated question: %s',
    async (query) => {
      const r = await retrieve(memory, { docId: DOC_A, query, topK: 20 });
      expect(r.hits.length).toBeGreaterThan(0);
      expect(ids(r)).not.toContain(deletedId);
    },
  );

  it('drops hits outside the effective filter even if the backend ignores it', async () => {
    const leaky: RetrievalBackend = {
      ...spy(memory).backend,
      search: (req: SearchRequest) =>
        memory.search({ ...req, filter: undefined }),
    };
    const r = await retrieve(leaky, {
      docId: DOC_A,
      query: 'Section 5747.01 taxes imposed',
      mode: 'sparse',
      topK: 20,
      includeDeleted: false,
    });
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits.every((h) => h.chunk.amendmentStatus !== 'deleted')).toBe(
      true,
    );
  });

  it.each([
    'What changes for renters?',
    'What does this bill remove from current law?',
    'Which sections are struck?',
    'Is the old rule repealed or deleted?',
    'Does the bill eliminate the fee?',
    'What is no longer allowed?',
    'What used to be allowed?',
    'What used to say about fees?',
    'Which words were stricken?',
    'Was the fee replaced?',
    'What was substituted?',
    'Was the rule revised or modified?',
    'How does the new rule differ?',
    'What does current law say?',
    'Is it used instead of the old fee?',
    'What did the law say before?',
    'How does it amend the code?',
    'Which words does it strike?',
    ...REPORTED_CHANGE_QUESTIONS,
    'Does the bill cross out the wording about fees?',
    'The bill crosses out the existing rule.',
    'Which words are crossed out?',
    'Is the bill crossing out this section?',
    'Show the crossed-out text.',
    'What is crossed out?',
    'Does the law get rid of a rule?',
    'The bill gets rid of the previous language.',
    'Is the bill getting rid of those provisions?',
    'The bill got rid of this clause.',
    'What does it get rid of?',
    'Does the bill take out the section about fees?',
    'The bill takes out the old definition.',
    'Which words were taken out?',
    'Is it taking out a paragraph?',
    'The bill took out the sentence about fees.',
    'What did it take out?',
    'Which words does this bill take out?',
    'What was taken out?',
    'What old wording appears here?',
    'Which old language applies to fees?',
    'What was the old text?',
    'What is the old version?',
    "Show the bill's old wording.",
    'Explain the law’s old language.',
    'Show the section old text.',
    'Show the old version of the bill.',
    'Explain the old wording in this law.',
    'Show the old language from the act.',
    'What it used to say about fees',
    'What the law used to say about fees',
    'What did it previously say about fees?',
    'What did the law previously say about fees?',
    'Which words are scratched out?',
    'Does it scratch out a rule?',
    'Which text is lined out?',
    'Does the bill line out a clause?',
    'Show the strikethrough text.',
    'Which words have strikethrough?',
    'Show the strike-through wording.',
    'Show the struck-through text.',
    'Which words were struck through?',
    'WHAT DOES THIS BILL CROSS\nOUT?',
    'Does the bill get\trid of\nthat rule?',
  ])('recognises a change question: %s', (question) => {
    expect(asksAboutChanges(question)).toBe(true);
  });

  it.each([
    'When does it take effect?',
    'Who is an eligible town?',
    'What is the penalty per day?',
    'How is the exchange rate set?',
    'Who pays for snow removal?',
    'What is the climate change policy?',
    'How do I report changes in income?',
    'Can public workers strike?',
    'What does the amendment to section 5 cover?',
    'What used to apply?',
    'Is it before noon?',
    'Can I take out a loan?',
    'Does the bill let people take out a loan?',
    'The law lets a bank take out a loan.',
    'A person takes out insurance.',
    'Was a loan taken out?',
    'Who took out the trash?',
    'Is the business taking out insurance?',
    'How can I get rid of pests?',
    'Does the bill help get rid of pests?',
    'The rule gets rid of pests.',
    'Who gets rid of pests?',
    'Are towns getting rid of pests?',
    'Can people cross out of state?',
    'Does the bill let people cross out of state?',
    'Does the bill cross out of state?',
    'Who crosses out of state?',
    'Who crossed out a drawing?',
    'Is someone crossing out a picture?',
    'Show the crossed-out picture.',
    'Was a lottery ticket scratched out?',
    'Are parking spaces lined out?',
    'Is strikethrough available in the editor?',
    'Who reviews strike-through artwork?',
    'Is the old wording on the sign legible?',
    'Can people speak an old language?',
    'Who has old text messages?',
    'Is the old version of the app supported?',
    'Explain what it previously said about music.',
    'Does it get rid of pests? What is the bill about?',
    'cross out',
    'get rid of',
    'take out',
    'The bill cross outwards.',
    'Does it take out the ruler?',
    '',
  ])('rejects an unrelated question: %s', (question) => {
    expect(asksAboutChanges(question)).toBe(false);
  });

  it('passes chip filters through to the backend', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'fined appropriated effect',
      mode: 'dense',
      filter: { chunkType: ['penalty'] },
    });
    expect(
      r.hits.every((h) => h.chunk.chunkType === 'penalty' || h.injected),
    ).toBe(true);
    expect(ids(r)).toContain(makeChunkId(DOC_A, 'sec-4', 0));
  });
});

describe('definition injection', () => {
  const defChunk = (term: string): Chunk => ({
    ...CHUNKS_A[1]!,
    id: makeChunkId(DOC_A, `def-${term}`, 0),
    sectionId: `def-${term}`,
    text: `The term "${term}" means something.`,
    embedText: `Definitions: ${term}`,
    definesTerm: term,
  });
  const user = (n: number, terms: string[]): Chunk => ({
    ...CHUNKS_A[2]!,
    id: makeChunkId(DOC_A, `use-${String(n)}`, 0),
    sectionId: `use-${String(n)}`,
    text: `widget rule ${String(n)}`,
    embedText: `widget rule ${String(n)}`,
    definedTermsUsed: terms,
  });

  it('appends the definition of a used term and marks it injected', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'award grants water treatment upgrades',
      mode: 'sparse',
      topK: 1,
    });
    expect(ids(r)).toEqual([
      makeChunkId(DOC_A, 'sec-3', 0),
      makeChunkId(DOC_A, 'sec-2', 0),
    ]);
    expect(r.hits.map((h) => h.injected)).toEqual([false, true]);
    expect(r.injectedDefinitions.map((c) => c.definesTerm)).toEqual([
      'eligible town',
    ]);
  });

  it('does not inject a definition that is already among the hits', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'eligible town municipality grants',
      mode: 'sparse',
    });
    expect(ids(r)).toContain(makeChunkId(DOC_A, 'sec-2', 0));
    expect(r.injectedDefinitions).toEqual([]);
  });

  it('caps injection at 5, preferring the most-used terms', async () => {
    const backend = new MemoryBackend();
    const terms = ['t1', 't2', 't3', 't4', 't5', 't6', 't7'];
    // t7 is used by two hits, so it must survive the cap even though it sorts last.
    await backend.upsertChunks(DOC_A, [
      ...terms.map(defChunk),
      user(1, terms),
      user(2, ['t7']),
    ]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      topK: 2,
    });
    expect(r.injectedDefinitions).toHaveLength(MAX_INJECTED_DEFINITIONS);
    expect(r.injectedDefinitions[0]!.definesTerm).toBe('t7');
    expect(r.injectedDefinitions.map((c) => c.definesTerm)).toEqual([
      't7',
      't1',
      't2',
      't3',
      't4',
    ]);
  });

  it('does not inject deleted definitions unless includeDeleted', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, [
      { ...defChunk('t1'), amendmentStatus: 'deleted' },
      user(1, ['t1']),
    ]);
    const q = { docId: DOC_A, query: 'widget rule', mode: 'sparse' as const };
    expect((await retrieve(backend, q)).injectedDefinitions).toEqual([]);
    expect(
      (await retrieve(backend, { ...q, includeDeleted: true }))
        .injectedDefinitions,
    ).toHaveLength(1);
  });

  it('prefers the live definition over a struck one and still fetches it', async () => {
    const backend = new MemoryBackend();
    const struck = {
      ...defChunk('town'),
      id: makeChunkId(DOC_A, 'def-town-old', 0),
      amendmentStatus: 'deleted' as const,
    };
    const live = { ...defChunk('town'), amendmentStatus: 'inserted' as const };
    await backend.upsertChunks(DOC_A, [struck, live, user(1, ['town'])]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      includeDeleted: true,
      topK: 1,
    });
    expect(r.injectedDefinitions.map((c) => c.id)).toEqual([live.id]);
    // a struck definition among the hits does not mark the term as covered
    expect(
      termsNeedingDefinitions([
        { chunk: struck, score: 1 },
        { chunk: user(2, ['town']), score: 1 },
      ]),
    ).toEqual(['town']);
  });

  it('does not show a struck definition twice when it is also ranked', async () => {
    const backend = new MemoryBackend();
    const struck = { ...defChunk('t1'), amendmentStatus: 'deleted' as const };
    await backend.upsertChunks(DOC_A, [struck, user(1, ['t1'])]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'term t1 means something widget rule',
      mode: 'sparse',
      includeDeleted: true,
    });
    expect(ids(r).filter((id) => id === struck.id)).toHaveLength(1);
    expect(r.injectedDefinitions).toEqual([]);
  });

  it('injects live definitions even when the chip filter is only inserted+deleted', async () => {
    const backend = new MemoryBackend();
    const used = { ...user(1, ['t1']), amendmentStatus: 'inserted' as const };
    await backend.upsertChunks(DOC_A, [defChunk('t1'), used]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      filter: { amendmentStatus: ['inserted', 'deleted'] },
    });
    expect(r.injectedDefinitions.map((c) => c.definesTerm)).toEqual(['t1']);
    expect(r.injectedDefinitions[0]!.amendmentStatus).toBe('unchanged');
  });

  it('falls back to a struck definition only when no live one exists', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, [
      { ...defChunk('t1'), amendmentStatus: 'deleted' },
      user(1, ['t1']),
    ]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      includeDeleted: true,
    });
    expect(r.injectedDefinitions.map((c) => c.amendmentStatus)).toEqual([
      'deleted',
    ]);
  });

  it('a multi-chunk definition does not starve other terms', async () => {
    const backend = new MemoryBackend();
    const alpha = [0, 1, 2, 3].map((i) => ({
      ...defChunk('alpha'),
      id: makeChunkId(DOC_A, `def-alpha-${String(i)}`, 0),
    }));
    await backend.upsertChunks(DOC_A, [
      ...alpha,
      defChunk('beta'),
      user(1, ['alpha', 'beta']),
    ]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
      topK: 1,
    });
    expect(r.injectedDefinitions.map((c) => c.definesTerm).sort()).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('ignores terms with no definition chunk', async () => {
    const backend = new MemoryBackend();
    await backend.upsertChunks(DOC_A, [user(1, ['ghost'])]);
    const r = await retrieve(backend, {
      docId: DOC_A,
      query: 'widget rule',
      mode: 'sparse',
    });
    expect(r.injectedDefinitions).toEqual([]);
  });

  it('termsNeedingDefinitions ranks by hit count, then alphabetically, skipping covered terms', () => {
    const mk = (c: Partial<Chunk>) => ({
      chunk: { definedTermsUsed: [], ...c } as never,
      score: 1,
    });
    expect(
      termsNeedingDefinitions([
        mk({ definedTermsUsed: ['b', 'a', 'a', 'covered'] }),
        mk({ definedTermsUsed: ['b'] }),
        mk({ definesTerm: 'covered' }),
      ]),
    ).toEqual(['b', 'a']);
  });
});

describe('usage, latency and abort', () => {
  it('sums usage over every backend call', async () => {
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'grants for water',
      mode: 'hybrid_rerank',
      topK: 1,
    });
    // dense (3) + sparse (3) query tokens, plus one definition lookup per injected term
    const raw = await retrieve(memory, {
      docId: DOC_A,
      query: 'grants for water',
      mode: 'hybrid_rerank',
      topK: 1,
      injectDefinitions: false,
    });
    expect(raw.usage.embedTokens).toBe(6);
    expect(r.injectedDefinitions.length).toBeGreaterThan(0);
    expect(r.usage.embedTokens).toBeGreaterThan(6);
    expect(r.usage.rerankUnits).toBe(1);
  });

  it('injectDefinitions: false skips the definition lookup and its embedding', async () => {
    const run = async (injectDefinitions: boolean) => {
      const s = spy(memory);
      const r = await retrieve(s.backend, {
        docId: DOC_A,
        query: 'award grants water treatment upgrades',
        mode: 'sparse',
        topK: 1,
        injectDefinitions,
      });
      return { r, searches: s.searches };
    };
    const on = await run(true);
    const off = await run(false);
    expect(off.searches).toHaveLength(1);
    expect(off.r.injectedDefinitions).toEqual([]);
    expect(on.searches.length).toBeGreaterThan(1);
    expect(on.r.injectedDefinitions).toHaveLength(1);
    expect(on.r.usage.embedTokens).toBeGreaterThan(off.r.usage.embedTokens);
  });

  it('measures latency with the injected clock', async () => {
    const ticks = [1000, 1042];
    const r = await retrieve(memory, {
      docId: DOC_A,
      query: 'grants',
      now: () => ticks.shift()!,
    });
    expect(r.latencyMs).toBe(42);
  });

  it('passes the abort signal to every backend call', async () => {
    const s = spy(memory);
    const controller = new AbortController();
    await retrieve(s.backend, {
      docId: DOC_A,
      query: 'grants for eligible town',
      signal: controller.signal,
    });
    expect(s.signals.length).toBeGreaterThanOrEqual(3);
    expect(s.signals.every((sig) => sig === controller.signal)).toBe(true);
  });

  it('rejects immediately when already aborted', async () => {
    const s = spy(memory);
    const controller = new AbortController();
    controller.abort();
    await expect(
      retrieve(s.backend, {
        docId: DOC_A,
        query: 'x',
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(s.searches).toHaveLength(0);
  });
});
