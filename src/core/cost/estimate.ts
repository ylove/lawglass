import type { PregenerateExamples } from '../breakdown/coverage.js';
import { MAP_UNITS_PER_CALL } from '../chip-summary.js';
import { EXCERPT_BATCH_SIZE, WHOLE_BATCH_SIZE } from '../breakdown/generate.js';
import {
  MAX_RELATED_SECTIONS,
  RELATED_TOKEN_BUDGET,
  MAX_REFERENCE_TEXTS,
  REFERENCE_CHAR_BUDGET,
} from '../breakdown/context.js';
import { MAX_INJECTED_DEFINITIONS } from '../retrieve/definitions.js';
import { DEFAULT_TOP_K } from '../retrieve/retrieve.js';
import { MAX_EXCERPT_REFERENCES } from '../answer/references.js';
import { MAX_TEXT_CHARS } from '../enrich/references.js';
import { ITEMS_PER_CALL } from '../picture/prompt.js';
import {
  maxTokensFor,
  type AnswerLimits,
  type AnswerMode,
} from '../answer/modes.js';
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
  /** Requested examples, capped to available breakdown units. Wins over `pregenerateExamples`. */
  exampleCount?: number;
  /**
   * The server's pre-generation policy (#382). `all` counts every breakdown unit, since which
   * briefs say `example: 'available'` is not known before they exist, so it is a high bound;
   * `off` counts none; `small` (default) counts up to 8, the most it ever pre-draws.
   */
  pregenerateExamples?: PregenerateExamples;
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
/**
 * Excerpt-mode contexts reach the model wrapped in escaped <excerpt> tags with ids, headings
 * and page/line markers, which chars/4 does not see. Measured on a 380K-character bill: about
 * 1.16 times the plain estimate; the high bound adds margin. Whole-bill contexts do not use
 * this: they are sized from the built prompt (see `wholeContext`).
 */
const PROMPT_MARKUP = { low: 1.1, high: 1.25 };
/**
 * Characters per token for the whole-bill prompt blocks (markup and text together), from the
 * calibration run (#385, docs/calibration.md). Measured input per call, less about 2,000 tokens
 * of system prompt, task and schema, over the characters `sizeWholePrompts` counts for the
 * same real bill, chunked and enriched as ingest does and with the U.S. Code references read
 * for it (a script ran `billFacts` on the fetched bills):
 *   S. 1582 (684 sections): summary 209,210 chars: 2.82; breakdown 198,263: 2.77;
 *                           scenario 200,437: 2.74; question (ordinary) 2.82
 *   Ohio S.B. 113 (101):    summary 31,160: 2.64; breakdown 31,160: 2.50; scenario 31,432: 2.56;
 *                           question (ordinary) 2.66
 *   NJ S. 1000 (3):         summary 2,582: 2.82; question (ordinary) 2.99
 * Low (2.9) is above every figure, so the low bound cannot exceed what was measured. High
 * (2.2) is about 12% under the lowest (2.50), a margin for denser text such as numeric tables
 * or citations, which tokenize worse than these bills; FRAMING.high carries about 1,000 tokens
 * above the fitted framing besides (breakdown framing runs higher than the
 * summary's: NJ's breakdown measured 3,504 tokens on 2,582 characters). Three bills are a thin
 * sample: the next calibration run should check this figure.
 */
const WHOLE_PROMPT_CHARS_PER_TOKEN = { low: 2.9, high: 2.2 };

/** A whole-bill prompt's bill-sized block, in tokens. Not scaled by PROMPT_MARKUP. */
function wholeContext(characters: number, highCharacters = characters): Bounds {
  return {
    low: Math.ceil(characters / WHOLE_PROMPT_CHARS_PER_TOKEN.low),
    high: Math.ceil(highCharacters / WHOLE_PROMPT_CHARS_PER_TOKEN.high),
  };
}

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
  /** Only at the high bound: work that a question may or may not trigger (an optional story). */
  highOnly?: boolean;
  /** The context is already sized from the built prompt, so PROMPT_MARKUP must not scale it. */
  promptSized?: boolean;
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
      if (spec.highOnly && bound === 'low') continue;
      const count = bound === 'low' ? 1 : (spec.highCalls ?? 1);
      for (let n = 0; n < count; n++) {
        const context = spec.promptSized
          ? spec.context[bound]
          : Math.ceil(spec.context[bound] * PROMPT_MARKUP[bound]);
        const prefix = spec.cachedPrefix ? context + FRAMING[bound] : 0;
        const caching = spec.cachedPrefix === true && plan.cache !== 'none';
        // The high bound never counts on a cache hit: the provider's cache lasts minutes, and
        // background batches can run further apart than that, so every prefix may be rewritten.
        const read =
          bound === 'low' && caching && prefixWritten && plan.cache !== 'cold';
        const overhead = thinking
          ? (plan.thinkingTokensPerCall?.[bound] ?? 0)
          : 0;
        const tokens: CallTokens = {
          inputTokens: context + FRAMING[bound] + (spec.cachedPrefix ? 300 : 0),
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
function examplesForPolicy(policy: PregenerateExamples | undefined): number {
  if (policy === 'all') return Infinity;
  if (policy === 'off') return 0;
  return 8;
}

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
  // Breakdown decides without reserving reference tokens, so it can be whole when the rest is not.
  const wholeBreakdown = facts.wholePrompt.breakdown > 0;
  const summary: CallSpec[] = [];
  if (plan.summary !== false && facts.characters > 0) {
    if (whole)
      summary.push({
        context: wholeContext(
          facts.wholePrompt.summary,
          facts.wholePrompt.summaryHigh,
        ),
        promptSized: true,
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
          wholeBreakdown ? WHOLE_BATCH_SIZE : EXCERPT_BATCH_SIZE,
        ).map((batch) => ({
          context: wholeBreakdown
            ? wholeContext(facts.wholePrompt.breakdown)
            : {
                low: batch.reduce((a, b) => a + b, 0),
                high: batch.reduce((a, b) => a + b + RELATED_TOKENS, 0),
              },
          promptSized: wholeBreakdown,
          visibleOutput: batch.length * 200,
          maxTokens: 6000,
          highCalls: 3,
          cachedPrefix: wholeBreakdown,
        }));
  const examples: CallSpec[] = facts.breakdownUnitTokens
    .slice(0, plan.exampleCount ?? examplesForPolicy(plan.pregenerateExamples))
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
          // The first call, one retry for malformed output, and one redraw of dropped items.
          highCalls: 3,
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
                ? wholeContext(facts.wholePrompt.scenario)
                : boundedContext(Math.min(facts.estimatedTokens, 8 * 450)),
              promptSized: whole,
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
      'Whole versus excerpts mode is forecast from the document chunked and enriched as ingest does; the runtime scan can still differ near the threshold. Whole-bill prompts are sized from the built <part> blocks at 2.2–2.9 characters per token. Before ingest has read its U.S. Code references, the summary and question blocks count each at its longest; the mode assumes none.',
      'Low: first pass and short output. High: full output budgets, all retries and reading-level rewrites.',
      `Cache policy: ${plan.cache ?? 'reuse'}; reuse assumes the same prefix stays cached for five minutes within each feature.`,
      `Thinking tokens per answer call: ${String(plan.thinkingTokensPerCall?.low ?? 0)}–${String(plan.thinkingTokensPerCall?.high ?? 0)}; included within output limits, high reserves the full limit.`,
      'Picture item counts and prompt framing are forecasts; metadata may already be present and require no call.',
      'Question/chip/locate estimate is separate from bill totals; excludes optional scenarios, embeddings, reranking and hosting.',
    ],
  };
}

/** Which read a question asks for and the output caps it runs under (see `core/answer/modes.ts`). */
export interface QuestionOptions {
  mode?: AnswerMode | undefined;
  limits?: AnswerLimits | undefined;
}

/** One answer-like question/chip/locate, including a possible reading-level rewrite.
 * Model assignment is optional for the default Sonnet quote, explicit for other providers.
 */
export function estimateQuestion(
  facts: BillFacts,
  prices: PriceTable = {},
  plan: Partial<EstimatePlan> = {},
  question: QuestionOptions = {},
): FeatureEstimate {
  const assignment: EstimatePlan = {
    answerModel: 'claude-sonnet-5-5',
    extractModel: 'claude-haiku-5-5',
    ...plan,
  };
  validatePlan(assignment);
  // `focused` reads excerpts even when the bill would fit; `whole` and `auto` read the whole
  // bill exactly when it fits (a bill too long for that is answered from excerpts either way).
  const whole = facts.mode === 'whole' && question.mode !== 'focused';
  const wholeCap = maxTokensFor('whole', question.limits);
  const focusedCap = maxTokensFor('focused', question.limits);
  // The most an excerpt prompt can hold: the top chunks, the injected definitions and the
  // reference texts, each at its limit, wrapped in the excerpt markup. A bound, not a forecast.
  const focusedHigh = Math.ceil(
    (DEFAULT_TOP_K * 450 +
      MAX_INJECTED_DEFINITIONS * 450 +
      MAX_EXCERPT_REFERENCES * Math.ceil(MAX_TEXT_CHARS / 4)) *
      PROMPT_MARKUP.high,
  );
  // Forced to excerpts on an amended bill that fits whole, a change question retrieves sections
  // with their struck and inserted words inline: take the larger of the two bounds.
  // A bill that fits whole cannot send more than itself (and its references) plus the injected
  // definitions, however much the constants allow.
  const wholeSized = Math.ceil(
    wholeContext(facts.wholePrompt.questionHigh).high * PROMPT_MARKUP.high +
      MAX_INJECTED_DEFINITIONS * 450,
  );
  const focused: Bounds = {
    low: Math.ceil(3500 * PROMPT_MARKUP.low),
    high: Math.max(
      facts.mode === 'whole' && wholeSized > 0
        ? Math.min(focusedHigh, wholeSized)
        : focusedHigh,
      wholeContext(facts.wholePrompt.focusedChange).high,
    ),
  };
  // A typed question may also draw a short story: up to two object calls over the same read.
  const story = (context: Bounds): CallSpec => ({
    context,
    promptSized: true,
    visibleOutput: 800,
    maxTokens: 2000,
    highCalls: 2,
    highOnly: true,
  });
  // Read from excerpts, the story sees at most eight of them.
  const storyExcerpts: Bounds = {
    low: 0,
    high: Math.ceil(8 * 450 * PROMPT_MARKUP.high),
  };
  const spec = (
    context: Bounds,
    highCalls: number,
    sized: boolean,
  ): CallSpec => ({
    context,
    promptSized: sized,
    visibleOutput: 800,
    maxTokens: whole ? wholeCap : focusedCap,
    highCalls,
    cachedPrefix: whole,
  });
  if (!whole)
    return feature(
      assignment.answerModel,
      [spec(focused, 2, true), story(storyExcerpts)],
      assignment,
      prices,
    );
  const sizes = facts.wholePrompt;
  const ordinary = wholeContext(sizes.summary, sizes.summaryHigh);
  const changes = wholeContext(sizes.question, sizes.questionHigh);
  // An ordinary question may be rewritten for reading level: two calls. A question about
  // changes needs the bill's exact wording, so it is never rewritten: one call, on the larger
  // prompt. The high bound is whichever of the two reachable cases costs more.
  const usual = feature(
    assignment.answerModel,
    [spec(ordinary, 2, true), story(wholeContext(sizes.scenario))],
    assignment,
    prices,
  );
  const asked = feature(
    assignment.answerModel,
    [
      spec({ low: ordinary.low, high: changes.high }, 1, true),
      story(wholeContext(sizes.scenario)),
    ],
    assignment,
    prices,
  );
  // A change question that struck text takes over the whole-bill budget is answered from
  // retrieved excerpts instead: one uncached call on that (smaller) prompt, 8,192 output.
  const fallback =
    sizes.changeExcerpts > 0
      ? feature(
          assignment.answerModel,
          [
            {
              context: wholeContext(sizes.changeExcerpts),
              promptSized: true,
              visibleOutput: 800,
              maxTokens: focusedCap,
              highCalls: 1,
            },
            story(storyExcerpts),
          ],
          assignment,
          prices,
        )
      : undefined;
  // Each field takes the larger of the reachable cases, so the bound covers whichever happens:
  // the input is max(1 change call, 2 ordinary calls) and output and dollars are the larger too.
  const cases = [usual.high, asked.high, ...(fallback ? [fallback.high] : [])];
  const envelope = (pick: (t: TokenEstimate) => number): number =>
    Math.max(...cases.map(pick));
  return {
    ...usual,
    high: {
      calls: envelope((t) => t.calls),
      inputTokens: envelope((t) => t.inputTokens),
      cachedInputTokens: envelope((t) => t.cachedInputTokens),
      cacheWriteTokens: envelope((t) => t.cacheWriteTokens),
      outputTokens: envelope((t) => t.outputTokens),
      dollars: envelope((t) => t.dollars),
    },
  };
}
