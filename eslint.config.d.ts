// Types for the named export used by tests/brand-guard.test.ts.
export declare const brandGuard: {
  files: string[];
  ignores: string[];
  rules: {
    'no-restricted-syntax': [
      'error',
      ...{ selector: string; message: string }[],
    ];
  };
};
export declare const redosGuard: {
  files: string[];
  ignores: string[];
  plugins: Record<string, import('eslint').ESLint.Plugin>;
  rules: Record<string, 'error'>;
};
declare const config: unknown;
export default config;
