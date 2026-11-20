/**
 * Per-question answer mode and output caps.
 *
 * `AskRequest` (a frozen contract) has no `mode` field yet, so these live beside the answer
 * pipeline and the server reads the field with its own schema. See `docs/decisions/0018`.
 */
import { z } from 'zod';
import type { AskRequest } from '../model/index.js';

/**
 * Which context a question reads:
 * - `auto`: today's rule, the whole bill when it fits the whole-bill budget, else excerpts.
 * - `whole`: the whole bill when it fits; a bill too long for that is answered as `auto` would.
 * - `focused`: retrieved excerpts, even when the bill would fit whole.
 */
export const AnswerMode = z.enum(['auto', 'whole', 'focused']);
export type AnswerMode = z.infer<typeof AnswerMode>;

/** Request body field for the ask route; absent means `auto`. */
export const AskModeField = z.object({ mode: AnswerMode.optional() });

/** An ask request as the web client sends it: the frozen `AskRequest` plus the answer mode. */
export type AskWithMode = AskRequest & z.infer<typeof AskModeField>;

/** What a question actually read. */
export type RanMode = 'whole' | 'focused';

/** The ceilings on one answer call's output, thinking included (the API counts it in `max_tokens`). */
export interface AnswerLimits {
  wholeMaxTokens?: number | undefined;
  focusedMaxTokens?: number | undefined;
}

export const DEFAULT_WHOLE_MAX_TOKENS = 16_000;
export const DEFAULT_FOCUSED_MAX_TOKENS = 8192;
/** Below this a thinking model has too little room for its reasoning plus a cited answer. */
export const MIN_ANSWER_MAX_TOKENS = 1024;

export type Effort = 'low' | 'medium' | 'high';

/** The cap for one mode: the host's value, else today's default. */
export function maxTokensFor(
  mode: RanMode,
  limits: AnswerLimits | undefined,
): number {
  return mode === 'whole'
    ? (limits?.wholeMaxTokens ?? DEFAULT_WHOLE_MAX_TOKENS)
    : (limits?.focusedMaxTokens ?? DEFAULT_FOCUSED_MAX_TOKENS);
}

/** Throws a RangeError for a cap that is not a whole number of at least `MIN_ANSWER_MAX_TOKENS`. */
export function validateAnswerLimits(limits: AnswerLimits | undefined): void {
  for (const [name, value] of Object.entries(limits ?? {})) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < MIN_ANSWER_MAX_TOKENS)
    )
      throw new RangeError(
        `answerLimits.${name} must be a whole number of at least ${String(MIN_ANSWER_MAX_TOKENS)}.`,
      );
  }
}

const EFFORT_ORDER: readonly Effort[] = ['low', 'medium', 'high'];

/**
 * How much reasoning to allow under a cap. Thinking spends the same `max_tokens` as the visible
 * answer, so a low cap with the default effort can think its way to a cut-off reply. At or above
 * the default cap nothing changes (`base` is what the caller sent before this existed). Below
 * it, reasoning shrinks with the cap: under 6,000 tokens `low`, otherwise no more than `medium`.
 */
export function effortForCap(
  base: Effort | undefined,
  cap: number,
  defaultCap: number,
): Effort | undefined {
  if (cap >= defaultCap) return base;
  if (cap < 6000) return 'low';
  const ceiling = base ?? 'medium';
  return EFFORT_ORDER.indexOf(ceiling) > EFFORT_ORDER.indexOf('medium')
    ? 'medium'
    : ceiling;
}
