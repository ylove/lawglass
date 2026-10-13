import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default defineConfig(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'coverage/**',
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
    files: ['src/web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
  },
  {
    files: [
      'src/**/*.{js,jsx,ts,tsx}',
      'scripts/**/*.{js,jsx,ts,tsx}',
      'tests/**/*.{js,jsx,ts,tsx}',
    ],
    ignores: ['src/core/brand.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/legislation-summary/]',
          message: 'Use BRAND from src/core/brand.ts for the product name.',
        },
        {
          selector: 'TemplateElement[value.cooked=/legislation-summary/]',
          message: 'Use BRAND from src/core/brand.ts for the product name.',
        },
      ],
    },
  },
);
