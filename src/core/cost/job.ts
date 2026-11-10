/**
 * Job context and budgets for hosted use (ADR 0018, sections 5 and 6).
 *
 * A route that admits paid work opens a `JobScope` with `AsyncLocalStorage`. Everything that
 * work starts, including background generation behind promise chains, timers and the limits
 * queue, reads the same scope when it calls a model. That is how usage is attributed to a
 * reader and how a job's budget is enforced without threading parameters through every service.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from '../model/index.js';
import { callDollars, modelPrice, type PriceTable } from './prices.js';
import type { LlmUsage } from '../model/index.js';
import type { UsageEvent } from './usage.js';

export type JobKind = 'ingest' | 'question' | 'locate' | 'scenario' | 'example';

/** Who and what a model call is for. Carries no text, URLs or credentials. */
export interface JobContext {
  readerId: string;
  jobKind: JobKind;
  jobId: string;
  docId?: string;
  /** The host's opaque admission reference (1 to 128 of A-Za-z0-9_-), carried into every usage event (ADR 0018, part C). */
  ref?: string;
}

/** A ceiling in dollars (against the cost price table, from real usage), tokens, or both. */
export interface JobBudget {
  dollars?: number;
  tokens?: number;
}

export interface ModelChoice {
  answer?: string;
  extract?: string;
}

export interface JobScope {
  context: JobContext;
  budget?: JobBudget | undefined;
  /** Models chosen by `modelFor`; read by the server's routed runtime. */
  models?: ModelChoice | undefined;
  /** Prices for the dollar budget; defaults to the built-in table. */
  prices?: PriceTable | undefined;
  /** Receives every model call's usage with this job's context. */
  onUsage?: ((event: UsageEvent) => void | Promise<void>) | undefined;
  /** Called once, the first time the budget refuses a call. Counts only. */
  onBudgetExhausted?: ((spent: JobSpend) => void) | undefined;
  /**
   * The host's kill switch (ADR 0018, part C), checked before every model call this job makes,
   * background included. Synchronous: the host keeps its state in memory. A gate that returns
   * anything but `true`, or throws, is closed.
   */
  spendGate?: (() => boolean) | undefined;
  /** Shared by every scope derived from the same admission, so one budget covers them all. */
  spent: JobSpend;
}

export interface JobSpend {
  dollars: number;
  tokens: number;
  calls: number;
  exhausted: boolean;
  /** Why the latest call was refused, so a run that ends early can say so. */
  refusal: StopCause | undefined;
  /** The model of the latest charged call, to price a budget in another unit. */
  lastModel: string | undefined;
}

/** Why a job's model calls were refused. */
export type StopCause = 'budget' | 'spend_gate';

export function newSpend(): JobSpend {
  return {
    dollars: 0,
    tokens: 0,
    calls: 0,
    exhausted: false,
    refusal: undefined,
    lastModel: undefined,
  };
}

const storage = new AsyncLocalStorage<JobScope>();

export function runInJob<T>(scope: JobScope | undefined, fn: () => T): T {
  return scope ? storage.run(scope, fn) : fn();
}

export function currentJob(): JobScope | undefined {
  return storage.getStore();
}

/** The name of a (answer model, extract model) choice; `default` for a model not chosen. */
export function tierName(models: ModelChoice | undefined): string {
  return `${models?.answer ?? 'default'}+${models?.extract ?? 'default'}`;
}

/** The tier of the job this code runs in. Background state is kept per (document, tier). */
export function currentTier(): string {
  return tierName(currentJob()?.models);
}

/** True while the host's spend gate is open (a job without a gate is always open). */
export function spendGateOpen(
  scope: JobScope | undefined = currentJob(),
): boolean {
  if (!scope?.spendGate) return true;
  try {
    const open: unknown = scope.spendGate();
    return open === true;
  } catch {
    // A broken gate cannot be trusted to be open.
    return false;
  }
}

/** True when a model call may be made now: the gate is open and the budget has room. */
export function canSpend(scope: JobScope | undefined = currentJob()): boolean {
  return spendGateOpen(scope) && budgetRemaining(scope);
}

/** Why the job's latest refused call was refused; `budget` when none was. */
export function stopCause(
  scope: JobScope | undefined = currentJob(),
): StopCause {
  return scope?.spent.refusal ?? 'budget';
}

/**
 * Throws BUDGET_EXHAUSTED when the host's spend gate is closed (`details.reason` is
 * `spend_gate`) or this job has already spent its budget. Overshoot is one call.
 */
export function assertBudget(scope: JobScope | undefined = currentJob()): void {
  if (scope && !spendGateOpen(scope)) {
    scope.spent.refusal = 'spend_gate';
    throw new AppError('BUDGET_EXHAUSTED', 'The spend gate is closed.', {
      details: { reason: 'spend_gate' },
    });
  }
  const budget = scope?.budget;
  if (!scope || !budget) return;
  const { spent } = scope;
  const over =
    (budget.dollars !== undefined && spent.dollars >= budget.dollars) ||
    (budget.tokens !== undefined && spent.tokens >= budget.tokens);
  if (!over) return;
  spent.refusal = 'budget';
  if (!spent.exhausted) {
    spent.exhausted = true;
    try {
      scope.onBudgetExhausted?.({ ...spent });
    } catch {
      /* Logging must not change the refusal. */
    }
  }
  throw new AppError('BUDGET_EXHAUSTED');
}

/** False once the job's spend has reached its budget (a job without a budget always has room). */
export function budgetRemaining(
  scope: JobScope | undefined = currentJob(),
): boolean {
  const budget = scope?.budget;
  if (!scope || !budget) return true;
  const { spent } = scope;
  return !(
    (budget.dollars !== undefined && spent.dollars >= budget.dollars) ||
    (budget.tokens !== undefined && spent.tokens >= budget.tokens)
  );
}

/**
 * A new admission pays for a (document, tier) whose scope is spent: its budget and job id replace
 * the old ones, in place, so work already holding the scope sees them.
 */
export function topUp(live: JobScope, paid: JobScope): void {
  live.budget = paid.budget;
  live.context.jobId = paid.context.jobId;
  live.context.readerId = paid.context.readerId;
  if (paid.context.ref === undefined) delete live.context.ref;
  else live.context.ref = paid.context.ref;
  Object.assign(live.spent, newSpend());
}

/** Dollars per token at the dearest of the model's rates, so a conversion never allows more than the old ceiling did. */
function dollarsPerToken(scope: JobScope): number | undefined {
  const model =
    scope.spent.lastModel ?? scope.models?.answer ?? scope.models?.extract;
  if (!model) return undefined;
  try {
    const price = modelPrice(model, scope.prices);
    return Math.max(price.input, price.output) / 1_000_000;
  } catch {
    return undefined;
  }
}

const unitsOf = (b: JobBudget): string =>
  `${b.tokens === undefined ? '' : 't'}${b.dollars === undefined ? '' : 'd'}`;

/**
 * A new admission pays for a (document, tier) whose scope still has budget: its budget is added
 * to the live one, and later calls are reported under the new job and reference. Nothing a
 * reader paid for is dropped. An unbounded scope is left as it is. Budgets in the same unit are
 * summed; in different units both become dollars at the scope's model prices (or, for a model
 * with no price, the grant replaces the old ceiling), so a grant is never capped by the old unit.
 */
export function addBudget(live: JobScope, paid: JobScope): void {
  // An unbounded scope needs no grant: it keeps its first admission and its attribution.
  if (live.budget === undefined) return;
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined ? b : b === undefined ? a : a + b;
  if (paid.budget === undefined) {
    // An unbounded grant makes the scope unbounded.
    live.budget = undefined;
  } else if (unitsOf(live.budget) === unitsOf(paid.budget)) {
    const tokens = sum(live.budget.tokens, paid.budget.tokens);
    const dollars = sum(live.budget.dollars, paid.budget.dollars);
    live.budget = {
      ...(tokens === undefined ? {} : { tokens }),
      ...(dollars === undefined ? {} : { dollars }),
    };
  } else {
    const rate = dollarsPerToken(live);
    const lastModel = live.spent.lastModel;
    if (rate === undefined) {
      live.budget = paid.budget;
    } else {
      const inDollars = (b: JobBudget, spent: JobSpend): number => {
        const left = [
          b.dollars === undefined ? undefined : b.dollars - spent.dollars,
          b.tokens === undefined ? undefined : (b.tokens - spent.tokens) * rate,
        ].filter((n): n is number => n !== undefined);
        return Math.max(0, Math.min(...left));
      };
      live.budget = {
        dollars:
          inDollars(live.budget, live.spent) +
          inDollars(paid.budget, newSpend()),
      };
    }
    // Dollars were not being counted under the old unit: start the new ceiling from zero spent.
    Object.assign(live.spent, newSpend(), { lastModel });
  }
  live.context.jobId = paid.context.jobId;
  live.context.readerId = paid.context.readerId;
  if (paid.context.ref === undefined) delete live.context.ref;
  else live.context.ref = paid.context.ref;
}

// --- grant epochs ----------------------------------------------------------------------------

const epochs = new Map<string, number>();
const EPOCH_CAP = 10_000;

/**
 * Counts the grants a (document, tier) has received. A stop mark or cool-down remembers the
 * epoch its run STARTED in; one from an older epoch is ignored, so a refusal that lands just
 * after someone paid never makes the payer wait.
 */
export function grantEpoch(docId: string, tier: string): number {
  return epochs.get(`${docId}\n${tier}`) ?? 0;
}

export function bumpGrantEpoch(docId: string, tier: string): void {
  const key = `${docId}\n${tier}`;
  if (epochs.size >= EPOCH_CAP && !epochs.has(key))
    for (const oldest of epochs.keys()) {
      epochs.delete(oldest);
      break;
    }
  epochs.set(key, (epochs.get(key) ?? 0) + 1);
}

export function isBudgetExhausted(error: unknown): boolean {
  return error instanceof AppError && error.code === 'BUDGET_EXHAUSTED';
}

/** True for the refusal a closed spend gate makes (a budget stop has no such reason). */
export function isSpendGateStop(error: unknown): boolean {
  return (
    error instanceof AppError &&
    error.code === 'BUDGET_EXHAUSTED' &&
    error.details?.reason === 'spend_gate'
  );
}

/** Add one reported call to the job's spend. An unpriced model fails closed for a dollar budget. */
export function chargeJob(
  scope: JobScope,
  model: string,
  usage: LlmUsage,
): void {
  const { spent } = scope;
  spent.calls += 1;
  spent.lastModel = model;
  spent.tokens += usage.inputTokens + usage.outputTokens;
  if (scope.budget?.dollars === undefined) return;
  try {
    spent.dollars += callDollars(
      {
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cacheReadTokens ?? 0,
        cacheWriteTokens: usage.cacheWriteTokens ?? 0,
        outputTokens: usage.outputTokens,
      },
      modelPrice(model, scope.prices),
    );
  } catch {
    // A model with no price cannot be bounded; stop rather than spend without limit.
    spent.dollars = Math.max(spent.dollars, scope.budget.dollars);
  }
}
