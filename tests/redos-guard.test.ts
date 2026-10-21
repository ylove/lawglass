/**
 * The ReDoS lint: untrusted legislation text must never reach a regular expression that can
 * backtrack super-linearly. Runs the exact `redosGuard` block exported from eslint.config.js
 * on known-bad patterns, so removing a rule (or the plugin) from the config fails here.
 */
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { redosGuard } from '../eslint.config.js';

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.ts'],
      languageOptions: { parser: tseslint.parser },
    },
    redosGuard,
  ],
});

async function ruleIds(source: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? '');
}

const BACKTRACKING = 'const bad = /^(a+)+$/;';
const MOVE = "const bad = 'x'.replace(/a+$/, '');";

test('nested quantifiers are rejected in src', async () => {
  expect(await ruleIds(BACKTRACKING, 'src/core/x.ts')).toContain(
    'regexp/no-super-linear-backtracking',
  );
});

test('a trailing-run replace is rejected in src and scripts', async () => {
  expect(await ruleIds(MOVE, 'src/core/x.ts')).toContain(
    'regexp/no-super-linear-move',
  );
  expect(await ruleIds(MOVE, 'scripts/x.ts')).toContain(
    'regexp/no-super-linear-move',
  );
});

test('linear patterns pass', async () => {
  expect(
    await ruleIds('const ok = /^\\d{1,4}-\\d+$/;', 'src/core/x.ts'),
  ).toEqual([]);
});

test('the real config applies the guard to source files', async () => {
  const config = (await new ESLint().calculateConfigForFile(
    'src/core/enrich/refs.ts',
  )) as { rules?: Record<string, unknown> } | undefined;
  expect(config?.rules?.['regexp/no-super-linear-backtracking']).toEqual([2]);
  expect(config?.rules?.['regexp/no-super-linear-move']).toEqual([2]);
});
