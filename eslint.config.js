import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

const BRAND_MESSAGE = 'Use BRAND from src/core/brand.ts for the product name.';

/**
 * The product name is not final, so it must live only in src/core/brand.ts. Exported so the
 * brand-guard test can exercise this exact rule without a slow type-aware lint.
 */
export const brandGuard = {
  files: [
    'src/**/*.{js,jsx,ts,tsx}',
    'scripts/**/*.{js,jsx,ts,tsx}',
    'tests/**/*.{js,jsx,ts,tsx}',
    'e2e/**/*.{js,jsx,ts,tsx}',
  ],
  ignores: ['src/core/brand.ts'],
  rules: {
    'no-restricted-syntax': [
      'error',
      {
        selector: 'Literal[value=/lawglass/i]',
        message: BRAND_MESSAGE,
      },
      {
        selector: 'TemplateElement[value.cooked=/lawglass/i]',
        message: BRAND_MESSAGE,
      },
      {
        selector: 'JSXText[value=/lawglass/i]',
        message: BRAND_MESSAGE,
      },
    ],
  },
};

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
      '.cache/**',
      'playwright-report/**',
      'test-results/**',
      'fixtures/downloads/**',
      '.worktrees/**',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Allow intentionally unused bindings (e.g. omitting a field via rest destructuring).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests index into known fixtures; non-null assertions there are clearer than guards.
    files: ['tests/**/*.{ts,tsx}', '**/*.test.{ts,tsx}'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  {
    files: ['src/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  brandGuard,
);
