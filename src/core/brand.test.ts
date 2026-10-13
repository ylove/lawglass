import { expect, test } from 'vitest';
import { BRAND, envVar } from './brand.js';

test('environment variables use the configured brand prefix', () => {
  expect(envVar('MAX_DOCS')).toBe(`${BRAND.envPrefix}_MAX_DOCS`);
  expect(envVar('LLM_PROVIDER')).toBe(`${BRAND.envPrefix}_LLM_PROVIDER`);
});
