import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createProgram } from './program.js';
import { createRuntimeFrom } from './runtime.js';

let home: string;
let written: string[];
let errors: string[];
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'no-llm-'));
  written = [];
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await rm(home, { recursive: true, force: true });
});

function run(argv: string[]): Promise<unknown> {
  const program = createProgram({
    // A terminal with no config and no keys: the case that used to ask for a provider.
    runtime: createRuntimeFrom({ env: {}, homeDir: home, isTTY: true }),
    write: (text) => written.push(text),
  });
  program.exitOverride();
  return program.parseAsync(['node', 'cli', ...argv]);
}

// Commands that never call a model must not ask for a provider: a missing document is the only
// thing to report.
test.each([[['search', 'nodoc', 'question']], [['get-section', 'nodoc', '1']]])(
  '%s needs no LLM provider',
  async (argv) => {
    await run(argv);
    expect(errors).toEqual(['That document has not been loaded.']);
    expect(written).toEqual([]);
  },
);

test('--json gets JSON for an unknown document', async () => {
  await run(['search', 'nodoc', 'question', '--json']);
  expect(JSON.parse(written.join(''))).toMatchObject({
    error: { code: 'DOC_NOT_FOUND' },
  });
});

test('remove needs no LLM provider', async () => {
  await expect(run(['remove', 'nodoc'])).rejects.toMatchObject({
    code: 'DOC_NOT_FOUND',
  });
});
