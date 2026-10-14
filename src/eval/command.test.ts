import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createRuntimeFrom } from '../cli/runtime.js';
import { fakePineconeClient } from '../../tests/contracts/fake-pinecone-client.js';
import { AppError } from '../core/model/index.js';
import { DetailedEvalRun } from './details.js';
import {
  makePipelineEnv,
  type PipelineEnv,
} from '../../tests/support/pipeline-env.js';
import { makeEvalBillHtml } from '../../tests/synth/index.js';
import { gitCommit, runEvalCommand, type EvalCommandDeps } from './command.js';

let env: PipelineEnv;
let dir: string;
let output: string;

beforeEach(async () => {
  env = await makePipelineEnv();
  dir = await mkdtemp(join(tmpdir(), 'eval-command-'));
  output = '';
  await mkdir(join(dir, 'golden'));
  await mkdir(join(dir, 'fixtures', 'downloads'), { recursive: true });
  const golden = JSON.parse(
    await readFile(
      new URL('./golden/synthetic-orchard.json', import.meta.url),
      'utf8',
    ),
  ) as { fixture: string };
  golden.fixture = 'orchard';
  await writeFile(join(dir, 'golden', 'orchard.json'), JSON.stringify(golden));
  await writeFile(
    join(dir, 'fixtures', 'manifest.json'),
    JSON.stringify({ fixtures: [{ name: 'orchard', format: 'html' }] }),
  );
  await writeFile(
    join(dir, 'fixtures', 'downloads', 'orchard.html'),
    makeEvalBillHtml().bytes,
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  await env.cleanup();
  await rm(dir, { recursive: true, force: true });
});

function deps(overrides: Partial<EvalCommandDeps> = {}): EvalCommandDeps {
  return {
    runtime: ({ backend }) =>
      backend === 'pinecone'
        ? Promise.reject(new AppError('BACKEND_UNAVAILABLE'))
        : Promise.resolve(env.runtime),
    write: (text) => {
      output += text;
    },
    cwd: dir,
    commit: () => Promise.resolve('deadbeef'),
    now: () => new Date('2026-10-13T12:00:00.000Z'),
    ...overrides,
  };
}

/** Directories the test fixtures live in, relative to the command's cwd. */
const where = { golden: 'golden', fixtures: 'fixtures' };

test('retrieval-only eval uses the Pinecone runtime with a fake client and no LLM key', async () => {
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const sdk = fakePineconeClient();
  const runtime = createRuntimeFrom({
    env: { PINECONE_API_KEY: 'pcsk_synthetic_eval_key' },
    homeDir: dir,
    isTTY: false,
    createPineconeClient: () => sdk.client,
  });
  await runEvalCommand({ ...where, backend: 'pinecone' }, deps({ runtime }));
  const md = await readFile(join(dir, 'eval', 'results.md'), 'utf8');
  expect(md).toContain('| pinecone | hybrid_rerank (rrf) |');
  expect(md).not.toContain('pending (');
  expect(output).toContain('5 rows, 0 pending backends');
  expect(sdk.dense.search).toHaveBeenCalled();
  expect(sdk.sparse.search).toHaveBeenCalled();
  expect(sdk.rerank).toHaveBeenCalled();
  expect(output).not.toContain('pcsk_synthetic_eval_key');
});

test('writes results.md and a run JSON, listing pinecone as pending', async () => {
  await runEvalCommand({ ...where }, deps());
  const md = await readFile(join(dir, 'eval', 'results.md'), 'utf8');
  expect(md).toContain('- Commit: deadbeef');
  expect(md).toContain('## orchard');
  expect(md).toContain('| local | hybrid_rerank (rrf) |');
  expect(md).toContain('| pinecone | all | pending (backend unavailable) |');
  const runs = await readdir(join(dir, 'eval', 'runs'));
  expect(runs).toEqual(['2026-10-13T12-00-00-000Z.json']);
  const saved = DetailedEvalRun.parse(
    JSON.parse(
      await readFile(join(dir, 'eval', 'runs', runs[0] ?? ''), 'utf8'),
    ),
  );
  expect(saved.rows).toHaveLength(5);
  expect(saved.rows.every((row) => row.questions.length > 0)).toBe(true);
  expect(md).not.toContain('firstRelevantRank');
  expect(md).not.toContain('top10');
  expect(output).toContain('Wrote ');
});

test('a missing key is pending (no key); --mode and --backend narrow the run', async () => {
  await runEvalCommand(
    { ...where, mode: 'dense', backend: 'pinecone', out: 'out/r.md' },
    deps({
      runtime: () => Promise.reject(new AppError('MISSING_KEY')),
    }),
  );
  const md = await readFile(join(dir, 'out', 'r.md'), 'utf8');
  expect(md).toContain('pending (no key)');
  expect(md).not.toContain('| local |');
});

test('--answers scores answers with the runtime answer provider', async () => {
  await runEvalCommand(
    { ...where, answers: true, backend: 'local', mode: 'hybrid' },
    deps(),
  );
  const md = await readFile(join(dir, 'eval', 'results.md'), 'utf8');
  expect(md).toContain('### Answers');
  expect(md).toContain('| mock | deterministic |');
});

test('--answers without a key fails instead of printing a pending row', async () => {
  await expect(
    runEvalCommand(
      { ...where, answers: true, backend: 'local' },
      deps({ runtime: () => Promise.reject(new AppError('MISSING_KEY')) }),
    ),
  ).rejects.toMatchObject({ code: 'MISSING_KEY' });
});

test('a fixture that is not downloaded is skipped with its reason', async () => {
  await rm(join(dir, 'fixtures', 'downloads', 'orchard.html'));
  await runEvalCommand({ ...where, backend: 'local' }, deps());
  const md = await readFile(join(dir, 'eval', 'results.md'), 'utf8');
  expect(md).toContain('skipped (not downloaded');
});

test('invalid golden files are reported and bad options rejected', async () => {
  await writeFile(join(dir, 'golden', 'junk.json'), '{}');
  await runEvalCommand({ ...where, backend: 'local', mode: 'dense' }, deps());
  expect(output).toContain('Skipping invalid golden set junk.json');
  await expect(
    runEvalCommand({ ...where, mode: 'fast' }, deps()),
  ).rejects.toMatchObject({
    code: 'INVALID_INPUT',
  });
  await expect(
    runEvalCommand({ ...where, backend: 'chroma' }, deps()),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    runEvalCommand({ ...where, fixture: 'nope' }, deps()),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
});

test('other runtime errors propagate', async () => {
  await expect(
    runEvalCommand(
      { ...where, backend: 'local' },
      deps({ runtime: () => Promise.reject(new AppError('PROVIDER_ERROR')) }),
    ),
  ).rejects.toMatchObject({ code: 'PROVIDER_ERROR' });
  await expect(
    runEvalCommand(
      { ...where, backend: 'local' },
      deps({ runtime: () => Promise.reject(new Error('boom')) }),
    ),
  ).rejects.toThrow('boom');
});

test('gitCommit returns a sha in a repository and "unknown" outside one', async () => {
  expect(await gitCommit(process.cwd())).toMatch(/^[a-f0-9]{40}$/);
  expect(await gitCommit(dir)).toBe('unknown');
});
