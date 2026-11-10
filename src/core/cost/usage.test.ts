import { expect, it } from 'vitest';
import { addLlmUsage, NOOP_USAGE_SINK } from './usage.js';

it('adds retries without losing cache splits or mutating provider usage', () => {
  const a = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 70 };
  const b = { inputTokens: 80, outputTokens: 10, cacheWriteTokens: 60 };
  expect(addLlmUsage(a, b)).toEqual({
    inputTokens: 180,
    outputTokens: 30,
    cacheReadTokens: 70,
    cacheWriteTokens: 60,
  });
  expect(a).toEqual({
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 70,
  });
  expect(
    addLlmUsage(
      { inputTokens: 1, outputTokens: 2 },
      { inputTokens: 3, outputTokens: 4 },
    ),
  ).toEqual({ inputTokens: 4, outputTokens: 6 });
  expect(
    NOOP_USAGE_SINK.record({
      feature: 'summary',
      model: 'synthetic',
      usage: a,
    }),
  ).toBeUndefined();
});
