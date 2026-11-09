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
