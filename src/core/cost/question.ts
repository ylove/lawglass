/**
 * The worst-case cost of one typed question in each answer mode, for a host that turns it into
 * its own units (a price, a number of questions). Pure and built on `estimateQuestion`: no
 * network, no environment, no billing rules.
 */
import type { AnswerLimits } from '../answer/modes.js';
import type { BillFacts } from './facts.js';
import {
  estimateQuestion,
  type EstimatePlan,
  type TokenEstimate,
} from './estimate.js';
import type { PriceTable } from './prices.js';

export interface QuestionCeiling {
  model: string;
  /**
   * What one focused answer can cost at most: retrieved excerpts, the focused output cap, and
   * every reachable retry (a reading-level rewrite).
   */
  focused: TokenEstimate;
  /**
   * What one whole-bill answer can cost at most. Absent when the bill is too long for the
   * whole-bill budget: a `whole` question is then answered from excerpts, so it costs `focused`.
   */
  whole?: TokenEstimate;
}

export interface QuestionCeilingOptions {
  /** Prices for models missing from the built-in table. */
  prices?: PriceTable | undefined;
  /** The same caps the server runs under (`AppOptions.answerLimits`). Default: today's caps. */
  limits?: AnswerLimits | undefined;
  /** Model and cache settings, as in a quote plan. Default: the Sonnet answer model. */
  plan?: Partial<EstimatePlan> | undefined;
}

/**
 * The high bound of one question per mode for a bill, from the facts of `billFacts`. `dollars`
 * on each side is the figure to price from; a bound, never a forecast.
 */
export function questionCeiling(
  facts: BillFacts,
  options: QuestionCeilingOptions = {},
): QuestionCeiling {
  const { prices, limits, plan } = options;
  const focused = estimateQuestion(facts, prices, plan, {
    mode: 'focused',
    limits,
    story: true,
  });
  if (facts.mode !== 'whole')
    return { model: focused.model, focused: focused.high };
  const whole = estimateQuestion(facts, prices, plan, {
    mode: 'whole',
    limits,
    story: true,
  });
  return { model: whole.model, focused: focused.high, whole: whole.high };
}
