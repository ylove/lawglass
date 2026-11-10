/**
 * The shape of a calibration report (#385). `scripts/calibrate.ts` writes it, and
 * `scripts/calibration-report.ts` reads it, so the two cannot drift apart: both parse with this.
 */
import { z } from 'zod';

/** Features the estimator forecasts, in the order a bill's work happens. */
export const FEATURES = [
  'metadata',
  'summary',
  'summaryScenario',
  'breakdown',
  'pictures',
  'examples',
] as const;
export type Feature = (typeof FEATURES)[number];

export const Tokens = z.object({
  calls: z.number(),
  inputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteTokens: z.number(),
  outputTokens: z.number(),
  dollars: z.number(),
});
export type Tokens = z.infer<typeof Tokens>;

const Ratio = z.number().nullable();

export const FeatureRow = z.object({
  model: z.string(),
  estimate: z.object({ low: Tokens, high: Tokens }),
  measured: Tokens.extend({
    /** Calls whose usage the provider did not report (failed or abandoned), so a guess was charged. */
    estimatedCalls: z.number(),
    /** Calls on a model the price table has no rate for, charged at the dearest built-in rate. */
    unpricedCalls: z.number(),
  }),
  /** Measured dollars over the estimate's high dollars; null when the estimate is zero. */
  ratioHigh: Ratio,
  ratioHighInput: Ratio,
  ratioHighOutput: Ratio,
});
export type FeatureRow = z.infer<typeof FeatureRow>;

const Quality = z.object({
  /** Answers or briefs examined. */
  items: z.number(),
  citations: z.number(),
  validCitations: z.number(),
  /** Valid over all citations; null when there were none. */
  validityRate: Ratio,
  /** Answers that declined (the document does not address it) or briefs left empty. */
  declines: z.number(),
  /** Answers carrying a warning such as NO_VALID_CITATIONS or TRUNCATED. */
  warned: z.number(),
});
export type Quality = z.infer<typeof Quality>;

export const RunStatus = z.enum([
  'completed',
  'stopped',
  'timeout',
  'failed',
  'skipped',
]);

export const Run = z.object({
  bill: z.string(),
  url: z.string(),
  plan: z.string(),
  answerModel: z.string(),
  extractModel: z.string(),
  breakdownMaxUnits: z.union([z.number(), z.literal('all')]),
  pregenerateExamples: z.enum(['all', 'small', 'off']),
  status: RunStatus,
  /** The caps the run was under, so a report rebuilt from run lines still knows them. */
  caps: z.object({ maxUsd: z.number(), maxUsdPerRun: z.number() }),
  /** Why a run did not complete: the budget that stopped it, the error, or the stage that stalled. */
  note: z.string().optional(),
  docId: z.string().optional(),
  facts: z
    .object({
      pages: z.number().nullable(),
      sections: z.number(),
      tokens: z.number(),
      mode: z.string(),
      /** Parts that got a brief in this run (after the cap). */
      units: z.number(),
      /** Parts the whole bill would brief with no cap, for per-part extrapolation. */
      unitsUncapped: z.number(),
    })
    .optional(),
  /** What the server's quote said for each tier it was configured with (low and high dollars). */
  quote: z
    .record(z.string(), z.object({ low: z.number(), high: z.number() }))
    .optional(),
  features: z.record(z.enum(FEATURES), FeatureRow),
  /** Free-text questions, priced against the one-question estimate. */
  questions: z.object({
    asked: z.number(),
    estimate: z.object({ low: Tokens, high: Tokens }),
    measured: Tokens,
    /** Measured dollars per question over the high dollars for one. */
    ratioHigh: Ratio,
  }),
  /** Usage outside the forecast: chips, locate, a question's story, unrecognised features. */
  other: Tokens,
  total: z.object({
    estimate: z.object({ low: Tokens, high: Tokens }),
    measured: Tokens,
    ratioHigh: Ratio,
    ratioLow: Ratio,
  }),
  quality: z.object({
    summary: Quality,
    briefs: Quality,
    answers: Quality,
  }),
  coverage: z.object({
    briefs: z.number(),
    omitted: z.number(),
    /** Briefs that say an example is available. */
    eligible: z.number(),
    pictures: z.number(),
    /** Null when examples were not requested one by one (the `small` policy). */
    examples: z.number().nullable(),
  }),
  /** Dollars per brief, picture and example, to scale a capped run up to the whole bill. */
  perUnit: z.object({
    breakdownDollarsPerBrief: Ratio,
    picturesDollarsPerBrief: Ratio,
    examplesDollarsPerExample: Ratio,
  }),
  spentUsd: z.number(),
  elapsedSeconds: z.number(),
});
export type Run = z.infer<typeof Run>;

export const CalibrationReport = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  dryRun: z.boolean(),
  caps: z.object({ maxUsd: z.number(), maxUsdPerRun: z.number() }),
  spentUsd: z.number(),
  /** True when the total cap stopped the run before every planned run finished. */
  capReached: z.boolean(),
  /** Runs that were not started, and why. */
  skipped: z.array(
    z.object({ bill: z.string(), plan: z.string(), reason: z.string() }),
  ),
  runs: z.array(Run),
});
export type CalibrationReport = z.infer<typeof CalibrationReport>;
