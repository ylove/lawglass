import { ESLint } from 'eslint';
import { beforeAll, expect, test } from 'vitest';
import { BRAND } from '../src/core/brand.js';

const eslint = new ESLint();

// The first type-aware lint builds the TypeScript program (5-7 s on CI runners); do it once
// up front with a generous timeout so individual tests measure only the rule.
beforeAll(async () => {
  await eslint.lintText('export {};', { filePath: 'src/core/config.ts' });
}, 60_000);

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

test.each([
  ['import specifier', `import '${BRAND.name}';`],
  ['JSX text', `export const label = <div>${BRAND.name}</div>;`],
  ['JSX attribute', `export const label = <div title="${BRAND.name}" />;`],
  [
    'mixed-case literal',
    `export const label = '${BRAND.name.replace('legislation', 'LeGiSlAtIoN')}';`,
  ],
  [
    'mixed-case template',
    'export const label = `' + BRAND.name.toUpperCase() + '-${1}`;',
  ],
  [
    'mixed-case JSX text',
    `export const label = <div>${BRAND.name.toUpperCase()}</div>;`,
  ],
  [
    'mixed-case JSX attribute',
    `export const label = <div title="${BRAND.name.toUpperCase()}" />;`,
  ],
])('brand guard rejects %s', async (_name, source) => {
  const [result] = await eslint.lintText(source, {
    filePath: 'src/web/App.tsx',
  });
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
