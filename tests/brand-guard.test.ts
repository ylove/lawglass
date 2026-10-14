/**
 * The brand guard: the product name may appear only in src/core/brand.ts.
 *
 * The rule is exercised with a lightweight ESLint instance (TypeScript parser, no type
 * information) running the exact `brandGuard` block exported from eslint.config.js. A full
 * type-aware lint builds the whole TypeScript program (5-60 s under load) and made this test
 * flaky; the real config is still checked below via calculateConfigForFile, which resolves
 * configuration without type-checking anything.
 */
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { expect, test } from 'vitest';
import { brandGuard } from '../eslint.config.js';
import { BRAND } from '../src/core/brand.js';

const eslint = new ESLint({
  overrideConfigFile: true,
  overrideConfig: [
    {
      files: ['**/*.{js,jsx,ts,tsx}'],
      languageOptions: {
        parser: tseslint.parser,
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
    },
    brandGuard,
  ],
});

async function brandViolations(source: string, filePath: string) {
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? []).filter(
    (message) => message.ruleId === 'no-restricted-syntax',
  );
}

test('the real ESLint config applies the exported brand guard (and exempts brand.ts)', async () => {
  const real = new ESLint();
  const ruleFor = async (file: string): Promise<unknown> => {
    const config = (await real.calculateConfigForFile(file)) as {
      rules?: Record<string, unknown>;
    };
    return config.rules?.['no-restricted-syntax'];
  };
  // ESLint normalizes severity 'error' to 2; compare the selectors and messages exactly.
  const [, ...expectedSelectors] = brandGuard.rules['no-restricted-syntax'];
  expect(await ruleFor('src/core/config.ts')).toEqual([
    2,
    ...expectedSelectors,
  ]);
  expect(await ruleFor('src/core/brand.ts')).toBeUndefined();
});

test.each([
  'src/core/config.ts',
  'scripts/index.ts',
  'tests/synth/index.ts',
  'src/web/App.tsx',
])('brand guard rejects string literals in %s', async (filePath) => {
  expect(
    await brandViolations(`export const label = '${BRAND.name}';`, filePath),
  ).toEqual([expect.objectContaining({ severity: 2 })]);
});

test.each([
  ['template element', 'export const label = `' + BRAND.name + '-${1}`;'],
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
  expect(await brandViolations(source, 'src/web/App.tsx')).not.toEqual([]);
});

test('brand definition is exempt', async () => {
  expect(
    await brandViolations(
      `export const label = '${BRAND.name}';`,
      'src/core/brand.ts',
    ),
  ).toEqual([]);
});

test('brand references are allowed', async () => {
  expect(
    await brandViolations(
      "import { BRAND } from './brand.js'; export const label = BRAND.name;",
      'src/core/config.ts',
    ),
  ).toEqual([]);
});
