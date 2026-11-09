import { MAP_UNITS_PER_CALL } from '../chip-summary.js';
import { EXCERPT_BATCH_SIZE, WHOLE_BATCH_SIZE } from '../breakdown/generate.js';
import {
  MAX_RELATED_SECTIONS,
  RELATED_TOKEN_BUDGET,
  MAX_REFERENCE_TEXTS,
  REFERENCE_CHAR_BUDGET,
} from '../breakdown/context.js';
import { MAX_INJECTED_DEFINITIONS } from '../retrieve/definitions.js';
import { ITEMS_PER_CALL } from '../picture/prompt.js';
import type { BillFacts } from './facts.js';
import {
  callDollars,
  modelPrice,
  type CallTokens,
  type PriceTable,
} from './prices.js';

export interface Bounds {
  low: number;
  high: number;
}
export interface ModelAssignment {
  answerModel: string;
  extractModel: string;
}
export interface EstimatePlan extends ModelAssignment {
  metadata?: boolean;
  summary?: boolean;
  summaryScenario?: boolean;
  breakdown?: boolean;
  pictures?: boolean;
  /** Requested examples, capped to available breakdown units. Default 8. */
  exampleCount?: number;
  /** Additional BILLABLE thinking tokens per answer-model call, within maxTokens.
   * Low adds this to the visible-output forecast; high already reserves maxTokens,
   * including thinking. Default 0; calibrate from the usage sink for the selected effort.
   */
  thinkingTokensPerCall?: Bounds;
  /** Assume a five-minute cache survives between calls sharing a prefix. Default 'reuse'.
   * 'cold' charges every prefix as a write; 'none' charges ordinary input for providers
   * without caching. The estimator does not assume reuse between different features.
   */
  cache?: 'reuse' | 'cold' | 'none';
}
export interface TokenEstimate extends CallTokens {
  calls: number;
  dollars: number;
}
export interface FeatureEstimate {
  model: string;
  low: TokenEstimate;
  high: TokenEstimate;
}
export interface BillEstimate {
  models: ModelAssignment;
  features: Record<
    | 'metadata'
    | 'summary'
    | 'summaryScenario'
    | 'breakdown'
    | 'pictures'
    | 'examples',
    FeatureEstimate
  >;
  total: { low: TokenEstimate; high: TokenEstimate };
  question: FeatureEstimate;
  assumptions: string[];
}

const EMPTY: TokenEstimate = {
  calls: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  dollars: 0,
};
const RELATED_TOKENS =
  MAX_INJECTED_DEFINITIONS * 450 +
  MAX_RELATED_SECTIONS * RELATED_TOKEN_BUDGET +
  MAX_REFERENCE_TEXTS * Math.ceil(REFERENCE_CHAR_BUDGET / 4);
/** Prompt/schema/citation framing is a heuristic, not a tokenizer or a provider guarantee. */
const FRAMING = { low: 1000, high: 3000 };

function sum(a: TokenEstimate, b: TokenEstimate): TokenEstimate {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    dollars: a.dollars + b.dollars,
  };
}

interface CallSpec {
  context: Bounds;
  visibleOutput: number;
  maxTokens: number;
  /** Calls at high include the initial call plus every retry/rewrite. */
  highCalls?: number;
  cachedPrefix?: boolean;
}

function feature(
  model: string,
  specs: CallSpec[],
  plan: EstimatePlan,
  prices: PriceTable,
  thinking = true,
): FeatureEstimate {
  const price = modelPrice(model, prices);
  const result: FeatureEstimate = {
    model,
    low: { ...EMPTY },
    high: { ...EMPTY },
  };
  for (const bound of ['low', 'high'] as const) {
    let prefixWritten = false;
    for (const spec of specs) {
      const count = bound === 'low' ? 1 : (spec.highCalls ?? 1);
      for (let n = 0; n < count; n++) {
        const prefix = spec.cachedPrefix
          ? spec.context[bound] + FRAMING[bound]
          : 0;
        const caching = spec.cachedPrefix === true && plan.cache !== 'none';
        const read = caching && prefixWritten && plan.cache !== 'cold';
        const overhead = thinking
          ? (plan.thinkingTokensPerCall?.[bound] ?? 0)
          : 0;
        const tokens: CallTokens = {
          inputTokens:
            spec.context[bound] +
            FRAMING[bound] +
            (spec.cachedPrefix ? 300 : 0),
          cachedInputTokens: read ? prefix : 0,
          cacheWriteTokens: caching && !read ? prefix : 0,
          outputTokens:
            bound === 'high'
              ? spec.maxTokens
              : Math.min(spec.maxTokens, spec.visibleOutput + overhead),
        };
        result[bound] = sum(result[bound], {
          ...tokens,
          calls: 1,
          dollars: callDollars(tokens, price),
        });
        prefixWritten ||= caching;
      }
    }
  }
  return result;
}

function batches(values: number[], size: number): number[][] {
  const result: number[][] = [];
  for (let i = 0; i < values.length; i += size)
    result.push(values.slice(i, i + size));
  return result;
}
function boundedContext(tokens: number): Bounds {
  return { low: tokens, high: tokens };
}
function validatePlan(plan: EstimatePlan): void {
  if (
    plan.exampleCount !== undefined &&
    (!Number.isSafeInteger(plan.exampleCount) || plan.exampleCount < 0)
  )
    throw new RangeError('Example count must be a nonnegative integer.');
  const thinking = plan.thinkingTokensPerCall;
  if (
    thinking &&
    (!Number.isSafeInteger(thinking.low) ||
      !Number.isSafeInteger(thinking.high) ||
      thinking.low < 0 ||
      thinking.high < thinking.low)
  )
    throw new RangeError(
      'Thinking tokens must be ordered nonnegative integer bounds.',
    );
}

/** Model-call estimates only: excludes embedding, reranking, storage, tax and hosting.
 * Low is a successful first pass with short visible output; high spends each call's entire
 * output budget and performs every malformed retry and reading-level rewrite. Neither is
 * a statistical confidence interval: input framing and generated item counts are forecasts.
 */
export function estimateBill(
  facts: BillFacts,
  plan: EstimatePlan,
  prices: PriceTable = {},
): BillEstimate {
  validatePlan(plan);
  // Fail explicitly even if a feature assigned to an unknown model is disabled.
  modelPrice(plan.answerModel, prices);
  modelPrice(plan.extractModel, prices);
  const whole = facts.mode === 'whole';
  const bill = boundedContext(facts.estimatedTokens);
  const summary: CallSpec[] = [];
  if (plan.summary !== false && facts.characters > 0) {
    if (whole)
      summary.push({
        context: bill,
        visibleOutput: 1000,
        maxTokens: 16_000,
        highCalls: 2,
        cachedPrefix: true,
      });
    else {
      const maps = batches(facts.mapUnitTokens, MAP_UNITS_PER_CALL);
      for (const batch of maps)
        summary.push({
          context: boundedContext(batch.reduce((a, b) => a + b, 0)),
          visibleOutput: 1000,
          maxTokens: 8192,
          highCalls: maps.length === 1 ? 2 : 1,
        });
      if (maps.length > 1)
        summary.push({
          context: { low: maps.length * 1000, high: maps.length * 8192 },
          visibleOutput: 1000,
          maxTokens: 8192,
          highCalls: 2,
        });
    }
  }
  const breakdown: CallSpec[] =
    plan.breakdown === false
      ? []
      : batches(
          facts.breakdownUnitTokens,
          whole ? WHOLE_BATCH_SIZE : EXCERPT_BATCH_SIZE,
        ).map((batch) => ({
          context: whole
            ? bill
            : {
                low: batch.reduce((a, b) => a + b, 0),
                high: batch.reduce((a, b) => a + b + RELATED_TOKENS, 0),
              },
          visibleOutput: batch.length * 200,
          maxTokens: 6000,
          highCalls: 3,
          cachedPrefix: whole,
        }));
  const examples: CallSpec[] = facts.breakdownUnitTokens
    .slice(0, plan.exampleCount ?? 8)
    .map((tokens) => ({
      context: { low: tokens, high: tokens + RELATED_TOKENS },
      visibleOutput: 800,
      maxTokens: 2000,
      highCalls: 2,
    }));
  const pictureSpecs: CallSpec[] = [];
  if (plan.pictures !== false) {
    // Summary and breakdown pictures are separate jobs, each with its own final partial batch.
    const counts = [
      summary.length ? facts.eligiblePictureItems.summary : 0,
      breakdown.length ? facts.eligiblePictureItems.breakdown : 0,
    ];
    for (const count of counts) {
      for (let i = 0; i < count; i += ITEMS_PER_CALL) {
        const items = Math.min(ITEMS_PER_CALL, count - i);
        pictureSpecs.push({
          // The server accepts generated picture items up to 4,000 characters each.
          context: { low: items * 100, high: items * 1000 },
          visibleOutput: items * 150,
          maxTokens: 3000,
          highCalls: 2,
        });
      }
    }
  }
  const features: BillEstimate['features'] = {
    metadata: feature(
      plan.extractModel,
      plan.metadata === false || facts.characters === 0
        ? []
        : [
            {
              context: boundedContext(Math.min(1500, facts.estimatedTokens)),
              visibleOutput: 200,
              maxTokens: 600,
            },
          ],
      plan,
      prices,
      false,
    ),
    summary: feature(plan.answerModel, summary, plan, prices),
    summaryScenario: feature(
      plan.answerModel,
      summary.length && plan.summaryScenario !== false && facts.singleSubject
        ? [
            {
              context: whole
                ? bill
                : boundedContext(Math.min(facts.estimatedTokens, 8 * 450)),
              visibleOutput: 800,
              maxTokens: 2000,
              highCalls: 2,
            },
          ]
        : [],
      plan,
      prices,
    ),
    breakdown: feature(plan.answerModel, breakdown, plan, prices),
    pictures: feature(plan.extractModel, pictureSpecs, plan, prices, false),
    examples: feature(plan.answerModel, examples, plan, prices),
  };
  return {
    models: { answerModel: plan.answerModel, extractModel: plan.extractModel },
    features,
    total: {
      low: Object.values(features).reduce((n, f) => sum(n, f.low), {
        ...EMPTY,
      }),
      high: Object.values(features).reduce((n, f) => sum(n, f.high), {
        ...EMPTY,
      }),
    },
    question: estimateQuestion(facts, prices, plan),
    assumptions: [
      'Approximate tokens = live characters / 4; indexed context can change mode near the threshold.',
      'Low: first pass and short output. High: full output budgets, all retries and reading-level rewrites.',
      `Cache policy: ${plan.cache ?? 'reuse'}; reuse assumes the same prefix stays cached for five minutes within each feature.`,
      `Thinking tokens per answer call: ${String(plan.thinkingTokensPerCall?.low ?? 0)}–${String(plan.thinkingTokensPerCall?.high ?? 0)}; included within output limits, high reserves the full limit.`,
      'Picture item counts and prompt framing are forecasts; metadata may already be present and require no call.',
      'Question/chip/locate estimate is separate from bill totals; excludes optional scenarios, embeddings, reranking and hosting.',
    ],
  };
}

/** One answer-like question/chip/locate, including a possible reading-level rewrite.
 * Model assignment is optional for the default Sonnet quote, explicit for other providers.
 */
export function estimateQuestion(
  facts: BillFacts,
  prices: PriceTable = {},
  plan: Partial<EstimatePlan> = {},
): FeatureEstimate {
  const assignment: EstimatePlan = {
    answerModel: 'claude-sonnet-5-5',
    extractModel: 'claude-haiku-5-5',
    ...plan,
  };
  validatePlan(assignment);
  const whole = facts.mode === 'whole';
  return feature(
    assignment.answerModel,
    [
      {
        context: whole
          ? boundedContext(facts.estimatedTokens)
          : boundedContext(3500),
        visibleOutput: 800,
        maxTokens: whole ? 16_000 : 8192,
        highCalls: 2,
        cachedPrefix: whole,
      },
    ],
    assignment,
    prices,
  );
}
