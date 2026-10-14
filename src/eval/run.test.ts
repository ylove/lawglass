import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeEvalBillHtml } from '../../tests/synth/index.js';
import { loadGoldenSets } from './golden.js';
import type { EvalFixture } from './fixtures.js';
import {
  runEval,
  scoreAnswers,
  scoreRetrieval,
  struckSpanTexts,
  liveSpanTexts,
  variantsFor,
  type RunEvalInput,
} from './run.js';
import type { GoldenQuestion, GoldenSet } from '../core/model/index.js';
import { AppError } from '../core/model/index.js';
import { DetailedEvalRun, firstRelevantRank } from './details.js';
import { mean, recallAtK, reciprocalRank } from './metrics.js';
import { MemoryBackend } from '../../tests/contracts/memory-backend.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
});

const bill = makeEvalBillHtml();
const fixture: EvalFixture = {
  name: 'synthetic-orchard',
  url: 'https://eval.test/orchard.html',
  bytes: bill.bytes,
  contentType: 'text/html',
};

async function syntheticGolden(): Promise<GoldenSet> {
  const { sets } = await loadGoldenSets(
    new URL('./golden/', import.meta.url).pathname,
  );
  const set = sets.find((s) => s.fixture === 'synthetic-orchard');
  if (!set) throw new Error('missing synthetic golden set');
  return set;
}

function baseInput(golden: GoldenSet[]): RunEvalInput {
  return {
    fixtures: [fixture],
    golden,
    backends: [{ kind: 'local', backend: env.backend, registry: env.registry }],
    extractProvider: env.provider,
    modes: ['dense', 'sparse', 'hybrid', 'hybrid_rerank'],
    commit: 'abc1234',
    now: () => new Date('2026-10-13T12:00:00.000Z'),
  };
}

test('every golden section id exists in the synthetic bill', async () => {
  const golden = await syntheticGolden();
  const ids = new Set(bill.groundTruth.sections.map((s) => s.id));
  for (const q of golden.questions)
    for (const id of q.expectedSectionIds) expect(ids).toContain(id);
  expect(new Set(golden.questions.map((q) => q.kind))).toEqual(
    new Set(['exact', 'paraphrase', 'definition', 'removed', 'unanswerable']),
  );
});

test('variantsFor adds weighted fusion only to hybrid', () => {
  expect(
    variantsFor(['dense', 'sparse', 'hybrid', 'hybrid_rerank'], true),
  ).toEqual([
    { mode: 'dense' },
    { mode: 'sparse' },
    { mode: 'hybrid', fusion: 'rrf' },
    { mode: 'hybrid', fusion: 'weighted' },
    { mode: 'hybrid_rerank', fusion: 'rrf' },
  ]);
  expect(variantsFor(['hybrid'], false)).toEqual([
    { mode: 'hybrid', fusion: 'rrf' },
  ]);
});

test('struckSpanTexts collects deleted spans from nested sections', () => {
  expect(
    struckSpanTexts({
      sections: bill.groundTruth.sections,
    }),
  ).toEqual(bill.groundTruth.deletedStrings);
});

test.each([false, true])(
  'coalesces deleted runs across printed lines (whitespace span: %s)',
  (whitespace) => {
    const doc: Parameters<typeof struckSpanTexts>[0] = {
      sections: [
        {
          id: 'sec-1',
          level: 1,
          children: [],
          spans: [
            {
              text: 'Orchard stewards may',
              status: 'deleted',
              page: 1,
              line: 1,
            },
            ...(whitespace
              ? [{ text: '\n', status: 'unchanged' as const, page: 1, line: 1 }]
              : []),
            {
              text: 'apply any pesticide',
              status: 'deleted',
              page: 1,
              line: 2,
            },
          ],
        },
      ],
    };
    const struck = struckSpanTexts(doc);
    expect(struck).toEqual(['Orchard stewards may apply any pesticide']);
    const scored = scoreAnswers(
      [
        {
          kind: 'exact',
          text: 'Orchard stewards may apply any pesticide.',
          declined: false,
          validCitations: 0,
          invalidCitations: 0,
          readingGrade: null,
        },
      ],
      struck,
    );
    expect(scored.metrics.deletedLeakageRate).toBe(1);
  },
);

test('keeps deleted runs separated by live text and section boundaries', () => {
  const doc: Parameters<typeof struckSpanTexts>[0] = {
    sections: [
      {
        id: 'sec-1',
        level: 1,
        spans: [
          { text: 'Orchard stewards may', status: 'deleted' },
          { text: 'Live rule.', status: 'inserted' },
          { text: 'apply any pesticide', status: 'deleted' },
        ],
        children: [
          {
            id: 'sec-1/a',
            level: 2,
            spans: [{ text: 'without advance notice', status: 'deleted' }],
            children: [],
          },
        ],
      },
    ],
  };
  expect(struckSpanTexts(doc)).toEqual([
    'Orchard stewards may',
    'apply any pesticide',
    'without advance notice',
  ]);
});

test('answer scoring excludes wording shared with live runs of the synthetic bill', () => {
  const doc = { sections: bill.groundTruth.sections };
  const struck = struckSpanTexts(doc);
  const live = liveSpanTexts(doc);
  expect(live).toContain(bill.groundTruth.insertedStrings[0]);
  const answer = {
    kind: 'exact' as const,
    text: bill.groundTruth.insertedStrings[0]!,
    declined: false,
    validCitations: 0,
    invalidCitations: 0,
    readingGrade: null,
  };
  expect(scoreAnswers([answer], struck, live).metrics.deletedLeakageRate).toBe(
    0,
  );
  expect(
    scoreAnswers(
      [{ ...answer, text: 'The harvest permit fee is twenty dollars.' }],
      struck,
      live,
    ).metrics.deletedLeakageRate,
  ).toBe(1);
});

test('scoreRetrieval skips unanswerable questions and sums usage', () => {
  const questions: GoldenQuestion[] = [
    { id: 'a', question: 'a', kind: 'exact', expectedSectionIds: ['sec-1'] },
    { id: 'b', question: 'b', kind: 'exact', expectedSectionIds: ['sec-2'] },
    { id: 'c', question: 'c', kind: 'unanswerable', expectedSectionIds: [] },
  ];
  const usage = { embedTokens: 5, rerankUnits: 2, readUnits: 0, writeUnits: 0 };
  const metrics = scoreRetrieval(
    questions,
    new Map([
      ['a', { hits: [{ sectionId: 'sec-1' }], usage, latencyMs: 4 }],
      [
        'b',
        {
          hits: [
            ...Array.from({ length: 6 }, () => ({ sectionId: 'sec-9' })),
            { sectionId: 'sec-2' },
          ],
          usage,
          latencyMs: 8,
        },
      ],
    ]),
  );
  expect(metrics).toEqual({
    recallAt5: 0.5,
    recallAt10: 1,
    mrr: (1 + 1 / 7) / 2,
    p50LatencyMs: 6,
    embedTokens: 10,
    rerankUnits: 4,
  });
});

test('scoreAnswers combines every answer metric', () => {
  const { metrics, removalAcknowledgedRate } = scoreAnswers(
    [
      {
        kind: 'removed',
        text: 'It was struck.',
        declined: false,
        validCitations: 1,
        invalidCitations: 1,
        readingGrade: 12,
      },
      {
        kind: 'unanswerable',
        text: 'No.',
        declined: true,
        validCitations: 0,
        invalidCitations: 0,
        readingGrade: null,
      },
    ],
    [],
  );
  expect(metrics).toEqual({
    citationValidity: 0.5,
    declineRate: 1,
    deletedLeakageRate: 0,
    meanReadingGrade: 12,
    answersAboveGrade9: 1,
  });
  expect(removalAcknowledgedRate).toBe(1);
});

test('runs retrieval for every variant, leaves the backend clean and never fetches the network', async () => {
  const golden = await syntheticGolden();
  const messages: string[] = [];
  const result = await runEval({
    ...baseInput([golden]),
    onProgress: (m) => messages.push(m),
  });
  expect(result.skipped).toEqual([]);
  expect(result.run).toMatchObject({
    runAt: '2026-10-13T12:00:00.000Z',
    commit: 'abc1234',
    goldenFrozenAtCommit: null,
  });
  expect(
    result.run.rows.map((r) => `${r.mode}${r.fusion ? `/${r.fusion}` : ''}`),
  ).toEqual([
    'dense',
    'sparse',
    'hybrid/rrf',
    'hybrid/weighted',
    'hybrid_rerank/rrf',
  ]);
  for (const row of result.run.rows) {
    expect(row.backend).toBe('local');
    expect(row.answers).toBeUndefined();
    expect(row.retrieval.recallAt10).toBeGreaterThanOrEqual(
      row.retrieval.recallAt5,
    );
    expect(row.questions.map((q) => q.id)).toEqual(
      golden.questions
        .filter((q) => q.kind !== 'unanswerable')
        .map((q) => q.id),
    );
    expect(
      mean(
        row.questions.map((q) => recallAtK(q.top10, q.expectedSectionIds, 5)),
      ),
    ).toBe(row.retrieval.recallAt5);
    expect(
      mean(
        row.questions.map((q) => recallAtK(q.top10, q.expectedSectionIds, 10)),
      ),
    ).toBe(row.retrieval.recallAt10);
    expect(
      mean(
        row.questions.map((q) => reciprocalRank(q.top10, q.expectedSectionIds)),
      ),
    ).toBe(row.retrieval.mrr);
    for (const q of row.questions) {
      expect(q.firstRelevantRank).toBe(
        firstRelevantRank(q.top10, q.expectedSectionIds),
      );
      expect(q.top10.length).toBeLessThanOrEqual(10);
      for (const hit of q.top10) {
        expect(Number.isFinite(hit.score)).toBe(true);
        expect(hit.breadcrumb).toBeTypeOf('string');
        expect(hit).not.toHaveProperty('text');
        expect(hit).not.toHaveProperty('embedText');
      }
    }
  }
  expect(DetailedEvalRun.parse(JSON.parse(JSON.stringify(result.run)))).toEqual(
    result.run,
  );
  const rerank = result.run.rows.at(-1);
  expect(rerank?.retrieval.rerankUnits).toBeGreaterThan(0);
  expect(result.run.rows[1]?.retrieval.embedTokens).toBe(0);
  expect(env.fetches).toEqual([]);
  expect(messages.length).toBeGreaterThan(0);
  const docId = (await env.registry.list())[0]?.docId ?? '';
  expect(await env.backend.hasDocument(docId)).toBe(false);
});

test('details work with the shared MemoryBackend double', async () => {
  const backend = new MemoryBackend();
  const golden = await syntheticGolden();
  const { run } = await runEval({
    ...baseInput([golden]),
    backends: [{ kind: 'local', backend, registry: env.registry }],
  });
  expect(run.rows).toHaveLength(5);
  for (const row of run.rows)
    expect(
      mean(
        row.questions.map((q) => recallAtK(q.top10, q.expectedSectionIds, 5)),
      ),
    ).toBe(row.retrieval.recallAt5);
});

test('keeps a document that was already indexed before the run', async () => {
  const golden = await syntheticGolden();
  const first = await runEval({ ...baseInput([golden]), modes: ['dense'] });
  expect(first.run.rows).toHaveLength(1);
  // Index it ourselves, then run again: eval must not delete what it did not add.
  env.serve(fixture.url, bill, 'text/html');
  const { ingest } = await import('../core/pipeline/index.js');
  const ingested = await ingest(fixture.url, {
    backend: env.backend,
    provider: env.provider,
    registry: env.registry,
    fetcher: env.runtime.fetcher,
    now: env.runtime.now,
  });
  await runEval({ ...baseInput([golden]), modes: ['dense'] });
  expect(await env.backend.hasDocument(ingested.doc.docId)).toBe(true);
});

test('with an answer provider, rows carry answer metrics and provider details', async () => {
  const golden = await syntheticGolden();
  const result = await runEval({
    ...baseInput([golden]),
    modes: ['hybrid'],
    answerProvider: env.provider,
  });
  const [rrf, weighted] = result.run.rows;
  expect(rrf?.provider).toBe('mock');
  expect(rrf?.model).toBe('deterministic');
  expect(rrf?.answers?.citationValidity).toBe(1);
  expect(result.extras[0]?.removalAcknowledgedRate).toBeDefined();
  // Weighted fusion is a retrieval comparison only.
  expect(weighted?.answers).toBeUndefined();
});

test('skips an unsupported fixture and reports golden sets with no document', async () => {
  const pdf: EvalFixture = {
    name: 'a-pdf',
    url: 'https://eval.test/a.pdf',
    bytes: new TextEncoder().encode('%PDF-1.7 not really'),
    contentType: 'application/pdf',
  };
  const golden = await syntheticGolden();
  const result = await runEval({
    ...baseInput([
      { ...golden, fixture: 'a-pdf', frozenAtCommit: 'f00' },
      { ...golden, fixture: 'not-supplied', frozenAtCommit: 'f00' },
    ]),
    fixtures: [pdf],
  });
  expect(result.run.rows).toEqual([]);
  expect(result.skipped).toMatchObject([
    { fixture: 'a-pdf', backend: 'local' },
  ]);
  expect(result.unmatchedGolden).toEqual(['not-supplied']);
  expect(result.run.goldenFrozenAtCommit).toBe('f00');
});

test('differing golden freeze commits are not collapsed into one', async () => {
  const golden = await syntheticGolden();
  const result = await runEval({
    ...baseInput([
      golden,
      { ...golden, fixture: 'other', frozenAtCommit: 'abc' },
    ]),
    modes: ['dense'],
  });
  expect(result.run.goldenFrozenAtCommit).toBeNull();
});

test('a non-AppError during a fixture run propagates', async () => {
  const golden = await syntheticGolden();
  const input = baseInput([golden]);
  const failing = Object.create(env.backend, {
    hasDocument: { value: () => Promise.reject(new Error('disk on fire')) },
  }) as typeof env.backend;
  await expect(
    runEval({
      ...input,
      backends: [{ kind: 'local', backend: failing, registry: env.registry }],
    }),
  ).rejects.toThrow('disk on fire');
});

test('backend initialization failure stops before existence checks and cleanup', async () => {
  vi.spyOn(env.backend, 'ensureReady').mockRejectedValue(
    new AppError('BACKEND_UNAVAILABLE'),
  );
  const exists = vi.spyOn(env.backend, 'hasDocument');
  const remove = vi.spyOn(env.backend, 'deleteDocument');
  await expect(
    runEval(baseInput([await syntheticGolden()])),
  ).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' });
  expect(exists).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});
