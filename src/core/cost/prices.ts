import { z } from 'zod';
import { AppError } from '../model/index.js';

const Rates = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .strict();
/** USD per million tokens. A tier applies to the ENTIRE call, including cached input. */
export const ModelPrice = Rates.extend({
  longContext: Rates.extend({
    aboveInputTokens: z.number().int().nonnegative(),
  })
    .strict()
    .optional(),
}).strict();
export type ModelPrice = z.infer<typeof ModelPrice>;
export const PriceTable = z.record(z.string().min(1), ModelPrice);
export type PriceTable = z.infer<typeof PriceTable>;

/** Issue #381 quote rates; overrides replace a model's complete rate card.
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-11-09).
 */
export const PRICES = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    longContext: {
      aboveInputTokens: 100_000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    },
  },
  'claude-sonnet-5-5': {
    input: 2,
    output: 10,
    // Kept at $0.20/MTok (the rate in our model reference) even if a lower published rate applies:
    // a price estimate may run high, never low.
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  // Official pricing confirms Opus cache reads at $0.20/MTok (0.05 x input).
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
} as const satisfies PriceTable;

export function modelPrice(
  model: string,
  overrides: PriceTable = {},
): ModelPrice {
  const table: PriceTable = { ...PRICES, ...overrides };
  if (!Object.hasOwn(table, model))
    throw new AppError('INVALID_INPUT', 'No price configured for model.', {
      userMessage:
        'No price configured for an assigned model. Set costPrices for the configured answerModel and extractModel.',
    });
  return ModelPrice.parse(table[model]);
}

export interface CallTokens {
  /** All input, including both cache categories, as in LlmUsage. */
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export function callDollars(tokens: CallTokens, price: ModelPrice): number {
  const rate =
    price.longContext && tokens.inputTokens > price.longContext.aboveInputTokens
      ? price.longContext
      : price;
  const ordinary =
    tokens.inputTokens - tokens.cachedInputTokens - tokens.cacheWriteTokens;
  return (
    (ordinary * rate.input +
      tokens.cachedInputTokens * rate.cacheRead +
      tokens.cacheWriteTokens * rate.cacheWrite +
      tokens.outputTokens * rate.output) /
    1_000_000
  );
}
