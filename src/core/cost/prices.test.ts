import { expect, it } from 'vitest';
import { callDollars, modelPrice, PRICES } from './prices.js';

it('applies the Haiku tier per call to ALL tokens, including cache input and output', () => {
  const price = modelPrice('claude-haiku-5-5');
  expect(
    callDollars(
      {
        inputTokens: 100_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 2000,
      },
      price,
    ),
  ).toBeCloseTo(0.011);
  expect(
    callDollars(
      {
        inputTokens: 100_001,
        cachedInputTokens: 100_000,
        cacheWriteTokens: 0,
        outputTokens: 2000,
      },
      price,
    ),
  ).toBeCloseTo(0.0100005);
  expect(
    callDollars(
      {
        inputTokens: 100_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 2000,
      },
      price,
    ) * 2,
  ).toBeCloseTo(0.022);
});
it('does not double-charge cached input and supports complete model price overrides', () => {
  expect(
    callDollars(
      {
        inputTokens: 1_000_000,
        cachedInputTokens: 400_000,
        cacheWriteTokens: 200_000,
        outputTokens: 100_000,
      },
      PRICES['claude-sonnet-5-5'],
    ),
  ).toBeCloseTo(2.38);
  const override = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 };
  expect(modelPrice('custom', { custom: override })).toEqual(override);
  expect(
    modelPrice('claude-sonnet-5-5', { 'claude-sonnet-5-5': override }),
  ).toEqual(override);
  expect(PRICES['claude-sonnet-5-5'].input).toBe(2);
  expect(modelPrice('claude-opus-5-5').cacheRead).toBe(0.2);
});
it('rejects missing models, prototype names, and invalid overrides explicitly', () => {
  for (const model of ['unknown', 'toString', '__proto__'])
    expect(() => modelPrice(model)).toThrow('No price configured');
  expect(() =>
    modelPrice('bad', {
      bad: { input: -1, output: 1, cacheRead: 0, cacheWrite: 1 },
    }),
  ).toThrow();
});
