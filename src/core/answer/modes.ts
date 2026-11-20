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

/** An ask request as the web client sends it. `mode` is part of `AskRequest` (#431). */
export type AskWithMode = AskRequest;

/** What a question actually read. */
export type RanMode = 'whole' | 'focused';

/** The ceilings on one answer call's output, thinking included (the API counts it in `max_tokens`). */
export interface AnswerLimits {
  wholeMaxTokens?: number | undefined;
  focusedMaxTokens?: number | undefined;
}

export const DEFAULT_WHOLE_MAX_TOKENS = 16_000;
export const DEFAULT_FOCUSED_MAX_TOKENS = 8192;
/** Enough for a low-effort reasoning pass and a cited answer; below it replies get cut off. */
export const MIN_ANSWER_MAX_TOKENS = 2048;
/** A conservative ceiling below current Claude output limits. */
export const MAX_ANSWER_MAX_TOKENS = 64_000;

const Cap = z
  .number()
  .int()
  .min(MIN_ANSWER_MAX_TOKENS)
  .max(MAX_ANSWER_MAX_TOKENS);
const AnswerLimitsSchema = z
  .object({ wholeMaxTokens: Cap.optional(), focusedMaxTokens: Cap.optional() })
  .strict();

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

/** Throws a RangeError for an unknown key or a cap that is not a whole number in range. */
export function validateAnswerLimits(limits: AnswerLimits | undefined): void {
  const parsed = AnswerLimitsSchema.safeParse(limits ?? {});
  if (!parsed.success)
    throw new RangeError(
      `answerLimits: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'value'} ${i.message}`).join('; ')} (caps are whole numbers from ${String(MIN_ANSWER_MAX_TOKENS)} to ${String(MAX_ANSWER_MAX_TOKENS)}).`,
    );
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
