/**
 * Full-coverage options (#382). Both are opt-in: the defaults keep the local and self-hosted
 * behaviour (30 briefs, examples drawn ahead only for a small bill). A paid hosted product turns
 * them up and prices the bill to match, with the cost estimator in `core/cost`.
 */
import { envVar } from '../brand.js';
import { AppError } from '../model/index.js';
import { MAX_BREAKDOWN_UNITS } from './units.js';

/** How many parts get a brief: a count, or `'all'` for every substantive part. */
export type BreakdownMaxUnits = number | 'all';

/** Which examples are drawn ahead of any click. `small` is "a bill with 1-8 of them". */
export type PregenerateExamples = 'small' | 'all' | 'off';

export const DEFAULT_PREGENERATE_EXAMPLES: PregenerateExamples = 'small';

/** The number `chooseBreakdownUnits` and `billFacts` take: `'all'` is no cap at all. */
export function unitCapOf(max: BreakdownMaxUnits | undefined): number {
  if (max === undefined) return MAX_BREAKDOWN_UNITS;
  if (max === 'all') return Infinity;
  if (max !== Infinity && (!Number.isSafeInteger(max) || max < 0))
    throw new RangeError(
      "The breakdown unit cap must be a nonnegative integer or 'all'.",
    );
  return max;
}

/** True when the cap goes beyond today's default, so batches are worth showing as they land. */
export function isFullCoverage(cap: number): boolean {
  return cap > MAX_BREAKDOWN_UNITS;
}

/** `<PREFIX>_BREAKDOWN_MAX_UNITS`: a count or `all`. Unset or unreadable keeps the default. */
export function breakdownMaxUnitsFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): BreakdownMaxUnits {
  const raw = env[envVar('BREAKDOWN_MAX_UNITS')]?.trim().toLowerCase();
  if (!raw) return MAX_BREAKDOWN_UNITS;
  if (raw === 'all') return 'all';
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
    ? Number(raw)
    : MAX_BREAKDOWN_UNITS;
}

/**
 * `<PREFIX>_PREGENERATE_EXAMPLES`: `0`/`off` turns it off (the original switch), `all` draws every
 * available example, anything else (or unset) is the small-bill rule.
 */
export function pregenerateExamplesFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PregenerateExamples {
  const raw = env[envVar('PREGENERATE_EXAMPLES')]?.trim().toLowerCase();
  if (raw === '0' || raw === 'off') return 'off';
  if (raw === 'all') return 'all';
  return DEFAULT_PREGENERATE_EXAMPLES;
}

/**
 * The job-budget hook (a separate change) throws an `AppError` with this code from
 * `Limits.meter`. Compared as a string so this code does not depend on that change landing first.
 */
export const BUDGET_EXHAUSTED = 'BUDGET_EXHAUSTED';

/** Why a background loop ended early; surfaced as `progress.stoppedReason`. */
export type StoppedReason = 'budget_exhausted';

export function isBudgetExhausted(error: unknown): error is AppError {
  return (
    error instanceof AppError && (error.code as string) === BUDGET_EXHAUSTED
  );
}
