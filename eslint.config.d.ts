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
declare const config: unknown;
export default config;
