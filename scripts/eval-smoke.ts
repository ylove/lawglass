/**
 * CI eval-smoke: runs the whole eval pipeline on the synthetic golden set, offline, with the
 * local backend and fake models, then asserts that
 *   1. the pipeline completes with a row for every mode, and
 *   2. hybrid_rerank recall@5 is at least dense recall@5.
 * Fake models make the numbers a plumbing check, not a quality result, so nothing here is
 * written to eval/results.md.
 *
 *   npx tsx scripts/eval-smoke.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBackend } from '../src/core/index/index.js';
import { MockProvider } from '../src/core/llm/mock.js';
import { Registry } from '../src/core/registry.js';
import {
  gitCommit,
  loadGoldenSets,
  renderResults,
  runEval,
  type EvalFixture,
} from '../src/eval/index.js';
import {
  FakeEmbedder,
  FakeReranker,
} from '../tests/contracts/fake-local-models.js';
import { makeEvalBillHtml } from '../tests/synth/index.js';

const SYNTHETIC_FIXTURE = 'synthetic-orchard';
const goldenDir = new URL('../src/eval/golden/', import.meta.url);

const { sets } = await loadGoldenSets(goldenDir.pathname);
const golden = sets.filter((g) => g.fixture === SYNTHETIC_FIXTURE);
if (golden.length === 0)
  throw new Error(`No valid golden set for ${SYNTHETIC_FIXTURE}.`);

const fixtures: EvalFixture[] = [
  {
    name: SYNTHETIC_FIXTURE,
    url: `https://synthetic.invalid/${SYNTHETIC_FIXTURE}.html`,
    bytes: makeEvalBillHtml().bytes,
    contentType: 'text/html',
  },
];

const dir = await mkdtemp(join(tmpdir(), 'eval-smoke-'));
try {
  const result = await runEval({
    fixtures,
    golden,
    backends: [
      {
        kind: 'local',
        backend: new LocalBackend({
          root: join(dir, 'store'),
          embedder: new FakeEmbedder(),
          reranker: new FakeReranker(),
        }),
        registry: new Registry(join(dir, 'config')),
      },
    ],
    extractProvider: new MockProvider(),
    modes: ['dense', 'sparse', 'hybrid', 'hybrid_rerank'],
    answerProvider: new MockProvider(),
    commit: await gitCommit(process.cwd()),
  });
  if (result.skipped.length > 0)
    throw new Error(`Skipped fixtures: ${JSON.stringify(result.skipped)}`);

  console.log(
    renderResults({
      run: result.run,
      extras: result.extras,
      pending: [],
      skipped: [],
      golden,
      retrievalModels: 'fake-bag-of-words (embedding), fake-overlap (reranker)',
      note: 'Smoke run: fake models and the mock LLM. A plumbing check, not a quality result.',
    }),
  );

  const recall5 = (mode: string, fusion?: string): number => {
    const row = result.run.rows.find(
      (r) => r.mode === mode && (fusion === undefined || r.fusion === fusion),
    );
    if (!row) throw new Error(`No ${mode} row in the eval run.`);
    return row.retrieval.recallAt5;
  };
  for (const mode of ['dense', 'sparse', 'hybrid', 'hybrid_rerank'])
    recall5(mode);
  const dense = recall5('dense');
  const rerank = recall5('hybrid_rerank');
  if (rerank < dense)
    throw new Error(
      `hybrid_rerank recall@5 (${rerank.toFixed(3)}) is below dense (${dense.toFixed(3)}).`,
    );
  console.log(
    `eval-smoke OK: ${String(result.run.rows.length)} rows; hybrid_rerank recall@5 ${rerank.toFixed(3)} >= dense ${dense.toFixed(3)}`,
  );
} finally {
  await rm(dir, { recursive: true, force: true });
}
