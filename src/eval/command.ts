/**
 * The `eval` CLI command: load golden sets, load fixtures from disk, run every requested
 * backend and mode, and write `eval/results.md` plus a machine-readable `eval/runs/*.json`.
 * Run it from the repository root: golden sets and fixtures are repo files, not shipped in dist/.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeFactory } from '../cli/runtime.js';
import { MODEL_LOCK } from '../core/index/local/models.js';
import { MockProvider } from '../core/llm/mock.js';
import {
  AppError,
  RETRIEVAL_MODES,
  type BackendKind,
  type LlmProvider,
  type RetrievalMode,
} from '../core/model/index.js';
import { Registry } from '../core/registry.js';
import { readDownloadedFixture, type EvalFixture } from './fixtures.js';
import { loadGoldenSets } from './golden.js';
import { renderResults, type PendingBackend } from './report.js';
import { runEval, type EvalBackendInput, type SkippedFixture } from './run.js';
import { DetailedEvalRun } from './details.js';

const run = promisify(execFile);

export interface EvalCommandOptions {
  fixture?: string | undefined;
  mode?: string | undefined;
  backend?: string | undefined;
  answers?: boolean | undefined;
  /** Golden set directory. Default `src/eval/golden`. */
  golden?: string | undefined;
  /** Fixtures directory holding `manifest.json` and `downloads/`. Default `fixtures`. */
  fixtures?: string | undefined;
  /** Results file. Default `eval/results.md`; run JSON goes to `runs/` beside it. */
  out?: string | undefined;
}

export interface EvalCommandDeps {
  runtime: RuntimeFactory;
  write: (text: string) => void;
  /** Working directory that relative defaults resolve against. Default `process.cwd()`. */
  cwd?: string | undefined;
  commit?: (() => Promise<string>) | undefined;
  now?: (() => Date) | undefined;
}

const BACKENDS: readonly BackendKind[] = ['local', 'pinecone'];

function parseModes(value: string | undefined): RetrievalMode[] {
  if (value === undefined || value === 'all') return [...RETRIEVAL_MODES];
  const mode = RETRIEVAL_MODES.find((m) => m === value);
  if (!mode)
    throw new AppError('INVALID_INPUT', `Unknown mode ${value}.`, {
      userMessage: `Unknown mode "${value}". Choose one of: ${RETRIEVAL_MODES.join(', ')}, all.`,
    });
  return [mode];
}

function parseBackends(value: string | undefined): BackendKind[] {
  // With no flag, try both: an unavailable backend shows up as a pending row, not a silent omission.
  if (value === undefined) return [...BACKENDS];
  const kind = BACKENDS.find((b) => b === value);
  if (!kind)
    throw new AppError('INVALID_INPUT', `Unknown backend ${value}.`, {
      userMessage: `Unknown backend "${value}". Choose local or pinecone.`,
    });
  return [kind];
}

export async function gitCommit(cwd: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD'], { cwd });
    return stdout.trim();
  } catch {
    return 'unknown';
  }
}

function pendingReason(error: AppError): string {
  return error.code === 'MISSING_KEY' ? 'no key' : 'backend unavailable';
}

export async function runEvalCommand(
  options: EvalCommandOptions,
  deps: EvalCommandDeps,
): Promise<void> {
  const cwd = deps.cwd ?? process.cwd();
  const modes = parseModes(options.mode);
  const kinds = parseBackends(options.backend);
  const loaded = await loadGoldenSets(
    resolve(cwd, options.golden ?? 'src/eval/golden'),
  );
  for (const bad of loaded.invalid)
    deps.write(`Skipping invalid golden set ${bad.file}: ${bad.reason}\n`);
  // Synthetic sets are CI plumbing checks with no downloadable fixture; run them only when named.
  const golden = loaded.sets.filter((g) =>
    options.fixture === undefined
      ? !g.fixture.startsWith('synthetic-')
      : g.fixture === options.fixture,
  );
  if (golden.length === 0)
    throw new AppError('INVALID_INPUT', 'No golden sets to evaluate.', {
      userMessage:
        options.fixture === undefined
          ? 'No valid golden sets found in src/eval/golden.'
          : `No valid golden set for fixture "${options.fixture}".`,
    });

  const fixtures: EvalFixture[] = [];
  const skipped: SkippedFixture[] = [];
  for (const set of golden) {
    const found = await readDownloadedFixture(
      resolve(cwd, options.fixtures ?? 'fixtures'),
      set.fixture,
    );
    if (found.fixture) fixtures.push(found.fixture);
    else
      skipped.push({
        fixture: set.fixture,
        backend: 'all',
        reason: found.missing ?? 'unavailable',
      });
  }

  const scratch = await mkdtemp(join(tmpdir(), 'eval-'));
  try {
    const backends: EvalBackendInput[] = [];
    const pending: PendingBackend[] = [];
    let answerProvider: LlmProvider | undefined;
    for (const kind of kinds) {
      try {
        const runtime = await deps.runtime({
          backend: kind,
          needsLlm: options.answers === true,
        });
        if (options.answers) answerProvider ??= runtime.answerProvider;
        backends.push({
          kind,
          backend: runtime.backend,
          registry: new Registry(join(scratch, kind)),
        });
      } catch (error) {
        if (
          !(error instanceof AppError) ||
          !['BACKEND_UNAVAILABLE', 'MISSING_KEY'].includes(error.code)
        )
          throw error;
        // `--answers` needs a key everywhere; for retrieval only, a missing backend is pending.
        if (options.answers && error.code === 'MISSING_KEY') throw error;
        pending.push({ backend: kind, reason: pendingReason(error) });
      }
    }

    const result = await runEval({
      fixtures,
      golden,
      backends,
      // Retrieval does not depend on bill metadata, so ingest uses the offline mock extractor.
      extractProvider: new MockProvider(),
      modes,
      answerProvider,
      commit: await (deps.commit ?? (() => gitCommit(cwd)))(),
      now: deps.now,
      onProgress: (message) => {
        deps.write(`${message}\n`);
      },
    });
    result.skipped.push(...skipped);

    const markdown = renderResults({
      run: result.run,
      extras: result.extras,
      pending,
      skipped: result.skipped,
      golden,
      retrievalModels: `local backend: ${MODEL_LOCK.embedding.id} (embedding), ${MODEL_LOCK.reranker.id} (reranker)`,
    });
    const out = resolve(cwd, options.out ?? 'eval/results.md');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, markdown);
    const runsDir = join(dirname(out), 'runs');
    await mkdir(runsDir, { recursive: true });
    const stamp = result.run.runAt.replace(/[:.]/g, '-');
    await writeFile(
      join(runsDir, `${stamp}.json`),
      `${JSON.stringify(DetailedEvalRun.parse(result.run), null, 2)}\n`,
    );
    deps.write(
      `Wrote ${out} (${String(result.run.rows.length)} rows, ${String(pending.length)} pending backends)\n`,
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
