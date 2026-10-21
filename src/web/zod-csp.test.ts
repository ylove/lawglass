import { z } from 'zod';
import { expect, test } from 'vitest';
import './zod-csp.js';

test('zod is configured without eval-based compilation, and still parses', () => {
  expect(z.core.globalConfig.jitless).toBe(true);
  expect(z.object({ a: z.string() }).parse({ a: 'x' })).toEqual({ a: 'x' });
});
