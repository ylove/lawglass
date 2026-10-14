import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { ScriptedProvider } from '../tests/contracts/scripted-provider.js';
import { runInjectionScript } from './eval-injection.js';

let dir: string;
let output: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'eval-injection-'));
  output = '';
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const run = (
  argv: string[],
  extra: Partial<Parameters<typeof runInjectionScript>[0]> = {},
) =>
  runInjectionScript({ argv, cwd: dir, write: (t) => (output += t), ...extra });

test('CI mode runs every case, writes the report and exits 0', async () => {
  const code = await run([]);
  expect(code).toBe(0);
  expect(output).toMatch(/injection eval \(mock\): 2\d\/2\d as expected/);
  const report = await readFile(join(dir, 'eval/results-injection.md'), 'utf8');
  expect(report).toContain('# Prompt-injection eval');
  expect(report).toContain('OBEYS every injection');
  expect(report).toContain('### direct-extract-prompt');
});

test('the report is identical across runs', async () => {
  await run(['--out', 'a.md']);
  await run(['--out', 'b.md']);
  expect(await readFile(join(dir, 'a.md'), 'utf8')).toBe(
    await readFile(join(dir, 'b.md'), 'utf8'),
  );
});

test('--case runs a subset; an unknown case is an error', async () => {
  expect(await run(['--case', 'direct-role-play', '--out', 'one.md'])).toBe(0);
  expect(await readFile(join(dir, 'one.md'), 'utf8')).toContain('Cases: 1 ');
  await expect(run(['--case', 'nope'])).rejects.toThrow(/Unknown case/);
});

test('live mode uses the injected provider, and a refusing model is a good outcome', async () => {
  // A well-behaved model: grounded answer with a real citation for everything.
  const polite = new ScriptedProvider({
    reply: 'The grant is up to eight thousand dollars [S:sec-4].',
  });
  const code = await run(
    [
      '--provider',
      'claude-cli',
      '--out',
      'live.md',
      '--case',
      'direct-role-play',
      '--case',
      'direct-extract-prompt',
    ],
    {
      makeLiveProvider: (id) => {
        expect(id).toBe('claude-cli');
        return polite;
      },
    },
  );
  expect(code).toBe(0);
  const report = await readFile(join(dir, 'live.md'), 'utf8');
  expect(report).toContain('Live run against mock / scripted');
  expect(report).toContain('the model resisted');
});

test('a live model that violates a defense makes the run fail', async () => {
  // Cites nothing real and nothing is flagged: one valid citation plus an uncited claim.
  const sloppy = new ScriptedProvider({
    reply: 'The grant is $8,000 [S:sec-4]. Also the sponsor is corrupt.',
  });
  const code = await run(
    [
      '--provider',
      'claude-cli',
      '--out',
      'bad.md',
      '--case',
      'direct-role-play',
    ],
    { makeLiveProvider: () => sloppy },
  );
  expect(code).toBe(1);
  expect(output).toContain('UNEXPECTED direct-role-play');
});

test('rejects an unknown provider and unknown flags', async () => {
  await expect(run(['--provider', 'bogus'])).rejects.toThrow(
    /Unknown provider/,
  );
  await expect(run(['--nope'])).rejects.toThrow();
});
