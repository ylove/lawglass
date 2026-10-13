import { ESLint } from 'eslint';
import { expect, test } from 'vitest';
import { BRAND } from '../src/core/brand.js';

const eslint = new ESLint();

test.each([
  'src/core/config.ts',
  'scripts/index.ts',
  'tests/synth/index.ts',
  'src/web/App.tsx',
])('brand guard rejects string literals in %s', async (filePath) => {
  const [result] = await eslint.lintText(
    `export const label = '${BRAND.name}';`,
    { filePath },
  );
  expect(result?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-syntax', severity: 2 }),
    ]),
  );
});

test('brand guard rejects template elements', async () => {
  const [result] = await eslint.lintText(
    'export const label = `' + BRAND.name + '-${1}`;',
    {
      filePath: 'src/core/config.ts',
    },
  );
  expect(result?.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ ruleId: 'no-restricted-syntax', severity: 2 }),
    ]),
  );
});

test('brand definition is exempt', async () => {
  const [result] = await eslint.lintText(
    `export const label = '${BRAND.name}';`,
    {
      filePath: 'src/core/brand.ts',
    },
  );
  expect(
    result?.messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax',
    ),
  ).toEqual([]);
});

test('brand references are allowed', async () => {
  const [result] = await eslint.lintText(
    "import { BRAND } from './brand.js'; export const label = BRAND.name;",
    { filePath: 'src/core/config.ts' },
  );
  expect(
    result?.messages.filter(
      (message) => message.ruleId === 'no-restricted-syntax',
    ),
  ).toEqual([]);
});
