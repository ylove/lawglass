import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../tests/support/pipeline-env.js';
import { makeEvalBillHtml } from '../tests/synth/index.js';
import { ZERO_USAGE, type EvalRow } from '../src/core/model/index.js';
import { loadGoldenSets, runEval } from '../src/eval/index.js';
import { assertSmokeRetrieval } from './eval-smoke.js';

let env: PipelineEnv;
beforeEach(async () => {
  env = await makePipelineEnv();
});
afterEach(() => env.cleanup());

async function smokeRows(): Promise<EvalRow[]> {
  const { sets } = await loadGoldenSets(
    new URL('../src/eval/golden/', import.meta.url).pathname,
  );
  const result = await runEval({
    fixtures: [
      {
        name: 'synthetic-orchard',
        url: 'https://synthetic.invalid/orchard.html',
        bytes: makeEvalBillHtml().bytes,
        contentType: 'text/html',
      },
    ],
    golden: sets.filter((s) => s.fixture === 'synthetic-orchard'),
    backends: [{ kind: 'local', backend: env.backend, registry: env.registry }],
    extractProvider: env.provider,
    modes: ['dense', 'sparse', 'hybrid', 'hybrid_rerank'],
    commit: 'test',
  });
  expect(result.skipped).toEqual([]);
  expect(result.run.rows).toHaveLength(5);
  return result.run.rows;
}

test('rejects complete retrieval failure even with all five rows and no skips', async () => {
  vi.spyOn(env.backend, 'search').mockResolvedValue({
    hits: [],
    usage: ZERO_USAGE,
  });
  const rows = await smokeRows();
  expect(rows.every((row) => row.retrieval.recallAt5 === 0)).toBe(true);
  expect(() => assertSmokeRetrieval(rows)).toThrow(/dense recall@5.*baseline/);
});

test('accepts the synthetic retrieval baseline and rejects a weak baseline or rerank regression', async () => {
  const rows = await smokeRows();
  expect(assertSmokeRetrieval(rows).dense).toBeGreaterThanOrEqual(0.5);
  const weak = rows.map((row) => ({
    ...row,
    retrieval: { ...row.retrieval, recallAt5: 0.01 },
  }));
  expect(() => assertSmokeRetrieval(weak)).toThrow(/baseline/);
  const regressed = rows.map((row) =>
    row.mode === 'hybrid_rerank'
      ? { ...row, retrieval: { ...row.retrieval, recallAt5: 0 } }
      : row,
  );
  expect(() => assertSmokeRetrieval(regressed)).toThrow(/below dense/);
  expect(() =>
    assertSmokeRetrieval(rows.filter((row) => row.mode !== 'sparse')),
  ).toThrow('No sparse row');
});
