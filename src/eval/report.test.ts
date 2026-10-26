import { expect, test } from 'vitest';
import type { EvalRun } from '../core/model/index.js';
import { renderResults, type ReportInput } from './report.js';

const retrieval = {
  recallAt5: 0.8,
  recallAt10: 0.9,
  mrr: 0.5,
  p50LatencyMs: 12.34,
  embedTokens: 100,
  rerankUnits: 7,
};

const run: EvalRun = {
  runAt: '2026-10-13T12:00:00.000Z',
  commit: 'abc1234',
  goldenFrozenAtCommit: null,
  rows: [
    { fixture: 'fx', backend: 'local', mode: 'dense', retrieval },
    {
      fixture: 'fx',
      backend: 'local',
      mode: 'hybrid',
      fusion: 'weighted',
      retrieval,
      provider: 'anthropic',
      model: 'some-model',
      answers: {
        citationValidity: 0.95,
        declineRate: 1,
        deletedLeakageRate: 0,
        meanReadingGrade: null,
        answersAboveGrade9: 2,
      },
    },
  ],
};

const input: ReportInput = {
  run,
  extras: [{}, { removalAcknowledgedRate: 0.5, inventedAnswerRate: 0 }],
  pending: [{ backend: 'pinecone', reason: 'no key' }],
  skipped: [{ fixture: 'fx', backend: 'local', reason: 'bad pdf' }],
  golden: [{ fixture: 'fx', frozenAtCommit: null }],
  retrievalModels: 'model-a + model-b',
};

test("states the commit, models, freeze state, and every row's backend, mode and provider", () => {
  const md = renderResults(input);
  expect(md).toContain('- Commit: abc1234');
  expect(md).toContain('- Retrieval models: model-a + model-b');
  expect(md).toContain('fx: unfrozen (draft)');
  expect(md).toContain(
    '| local | dense | 0.800 | 0.900 | 0.500 | 12.3 | 100 | 7 |',
  );
  expect(md).toContain('| local | hybrid (weighted) |');
  expect(md).toContain(
    '| local | hybrid (weighted) | anthropic | some-model | 95.0% | 100.0% | 0.0% | 0.0% | n/a | 2 | 50.0% |',
  );
});

test('shows unavailable backends and skipped fixtures as pending rows, with no invented numbers', () => {
  const md = renderResults(input);
  expect(md).toContain('| pinecone | all | pending (no key) |');
  expect(md).toContain('| local | all | skipped (bad pdf) |');
});

test('says when answers were not run and when nothing was evaluated', () => {
  const retrievalOnly = renderResults({
    ...input,
    run: { ...run, rows: run.rows.slice(0, 1) },
    note: 'Fake models.',
  });
  expect(retrievalOnly).toContain('Answer metrics: not run');
  expect(retrievalOnly).toContain('> Fake models.');
  const empty = renderResults({
    ...input,
    run: { ...run, rows: [] },
    golden: [],
    pending: [],
    skipped: [],
  });
  expect(empty).toContain('No golden sets with a matching fixture');
  expect(empty).toContain('Golden sets frozen at: none loaded');
});

test('answer rows without provider details are flagged rather than blank', () => {
  const [, withAnswers] = run.rows;
  if (!withAnswers) throw new Error('fixture');
  const { provider: _p, model: _m, ...bare } = withAnswers;
  const md = renderResults({
    ...input,
    run: { ...run, rows: [bare] },
    extras: [],
  });
  expect(md).toContain('| ? | ? |');
  expect(md).toContain('| n/a | 2 | n/a |');
});

test('documents the heuristic definitions and preserves missing invention scores as n/a', () => {
  const md = renderResults(input);
  expect(md).toContain('Invented answer rate');
  expect(md).toContain('explicit soft declines');
  expect(md).toContain('not an independent fact check');
  expect(md).toContain('all answers as its denominator');
  expect(md).toContain('not comparable with earlier');
  expect(renderResults({ ...input, extras: [] })).toContain(
    '| 95.0% | 100.0% | n/a |',
  );
});
