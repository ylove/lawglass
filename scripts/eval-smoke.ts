/**
 * CI eval-smoke: runs the whole eval pipeline on the synthetic golden set, offline, with the
 * local backend and fake models, then asserts that
 *   1. the pipeline completes with a row for every mode, and
 *   2. dense recall@5 meets a positive synthetic baseline, and
 *   3. hybrid_rerank recall@5 is at least dense recall@5.
 * Fake models make the numbers a plumbing check, not a quality result, so nothing here is
 * written to eval/results.md.
 *
 *   npx tsx scripts/eval-smoke.ts
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { EvalRow } from '../src/core/model/index.js';
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
// The fake bag-of-words model should find at least half of the synthetic expected sections.
const MIN_DENSE_RECALL_AT_5 = 0.5;

/** The same assertions used by the CLI, callable with a failed retrieval run in tests. */
export function assertSmokeRetrieval(rows: readonly EvalRow[]): {
  dense: number;
  rerank: number;
} {
  const recall5 = (mode: string, fusion?: string): number => {
    const row = rows.find(
      (r) => r.mode === mode && (fusion === undefined || r.fusion === fusion),
    );
    if (!row) throw new Error(`No ${mode} row in the eval run.`);
    return row.retrieval.recallAt5;
  };
  for (const mode of ['dense', 'sparse', 'hybrid', 'hybrid_rerank'])
    recall5(mode);
  const dense = recall5('dense');
  const rerank = recall5('hybrid_rerank');
  if (!(dense >= MIN_DENSE_RECALL_AT_5))
    throw new Error(
      `dense recall@5 (${dense.toFixed(3)}) does not meet the synthetic baseline (${MIN_DENSE_RECALL_AT_5.toFixed(3)}).`,
    );
  if (!(rerank >= dense))
    throw new Error(
      `hybrid_rerank recall@5 (${rerank.toFixed(3)}) is below dense (${dense.toFixed(3)}).`,
    );
  return { dense, rerank };
}

async function main(): Promise<void> {
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
        retrievalModels:
          'fake-bag-of-words (embedding), fake-overlap (reranker)',
        note: 'Smoke run: fake models and the mock LLM. A plumbing check, not a quality result.',
      }),
    );

    const { dense, rerank } = assertSmokeRetrieval(result.run.rows);
    console.log(
      `eval-smoke OK: ${String(result.run.rows.length)} rows; hybrid_rerank recall@5 ${rerank.toFixed(3)} >= dense ${dense.toFixed(3)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
