/**
 * The life of one gated attempt (issue #435), shared by model calls (`Limits.meter`) and billed
 * backend requests (Pinecone): ask the host's `callGate` and wait for it, no longer than the
 * reader stays or the gate timeout; check the budget and kill switch again once it answers; and
 * tell the host exactly once how the attempt ended. An approval that arrives after the wait was
 * cancelled ends that attempt unreported, and nothing is dispatched.
 */
import { randomUUID } from 'node:crypto';
import { AppError } from '../model/index.js';
import {
  assertBudget,
  currentJob,
  gateCall,
  type GateCall,
  type JobContext,
  type JobScope,
} from './job.js';
import { modelPrice } from './prices.js';

/** How long a host's gate may take to decide before the attempt is refused. */
export const DEFAULT_GATE_TIMEOUT_MS = 30_000;

/** One attempt, with the complete context it began under. */
export interface Attempt {
  callId: string;
  job: JobScope | undefined;
  /**
   * The job's context when this attempt began (reference and ids). Reporting and cleanup use
   * this, never the scope's later state: a top-up may switch the scope's payer meanwhile.
   */
  context: JobContext | undefined;
  /** A usage event was delivered for this attempt. */
  reported: boolean;
  /** Set right before the request leaves: only a dispatched attempt can have been billed. */
  dispatched: boolean;
  /** The gate allowed it and its end has not been told yet. */
  allowed: boolean;
}

export interface AttemptDescription {
  model: string;
  /** Only evaluated when the host has a call gate. */
  worstCaseUsd: number;
}

/**
 * Begins an attempt in the current job. Throws if the host refuses it, the reader leaves or the
 * gate times out while it decides, or (after the gate allows it) the budget, the kill switch or
 * the reader's signal says stop; in every such case no request is to be made.
 */
export async function beginAttempt(input: {
  describe: () => AttemptDescription;
  signal?: AbortSignal | undefined;
  gateTimeoutMs?: number | undefined;
}): Promise<Attempt> {
  const job = currentJob();
  const attempt: Attempt = {
    callId: randomUUID(),
    job,
    context: job ? { ...job.context } : undefined,
    reported: false,
    dispatched: false,
    allowed: false,
  };
  if (!job?.callGate) {
    attempt.allowed = true;
    return attempt;
  }
  const context = attempt.context ?? job.context;
  const described = input.describe();
  const decision = gateCall(job, {
    jobKind: context.jobKind,
    callId: attempt.callId,
    model: described.model,
    worstCaseUsd: described.worstCaseUsd,
    ...(context.ref === undefined ? {} : { ref: context.ref }),
    ...(context.docId === undefined ? {} : { docId: context.docId }),
  } satisfies GateCall);
  const wait = cancellation(
    input.signal,
    input.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
  );
  try {
    await Promise.race([decision, wait.promise]);
  } catch (error) {
    if (wait.cancelled()) {
      job.spent.refusal = 'spend_gate';
      // The host may approve (and reserve) after we gave up: that approval ends it, once.
      void decision.then(
        async () => {
          attempt.allowed = true;
          await endAttempt(attempt);
        },
        () => undefined,
      );
    }
    throw error;
  } finally {
    wait.dispose();
  }
  attempt.allowed = true;
  try {
    // The gate may have taken a while: the reader may be gone and the budget or kill switch
    // may have closed.
    input.signal?.throwIfAborted();
    assertBudget();
  } catch (error) {
    await endAttempt(attempt);
    throw error;
  }
  return attempt;
}

/** Tells the host this attempt ended (once). `reported` says whether a usage event was delivered. */
export async function endAttempt(attempt: Attempt): Promise<void> {
  const job = attempt.job;
  if (!attempt.allowed || !job?.onCallEnd) return;
  attempt.allowed = false;
  const context = attempt.context ?? job.context;
  try {
    await job.onCallEnd({
      callId: attempt.callId,
      reported: attempt.reported,
      jobKind: context.jobKind,
      ...(context.ref === undefined ? {} : { ref: context.ref }),
      ...(context.docId === undefined ? {} : { docId: context.docId }),
    });
  } catch {
    /* The host's bookkeeping failing must not change the request's result. */
  }
}

/**
 * A billed backend request (an embedding or rerank call to a hosted index) is gated like a model
 * call, and `onCallEnd` is told afterwards (`reported: false`: backends report no `UsageEvent`).
 * `worstCaseUsd` comes from the job's price table when it has an entry for `model` (its `input`
 * rate applied to one token per input byte, a bound), else `Infinity`: a host that gates
 * Pinecone inference must price it. `signal` ends the wait for the gate.
 */
export async function startBackendCall(input: {
  model: string;
  inputBytes: number;
  signal?: AbortSignal | undefined;
}): Promise<{ end(): Promise<void> }> {
  const attempt = await beginAttempt({
    signal: input.signal,
    describe: () => ({
      model: input.model,
      worstCaseUsd: backendWorstCase(input),
    }),
  });
  attempt.dispatched = true;
  return { end: () => endAttempt(attempt) };
}

function backendWorstCase(input: {
  model: string;
  inputBytes: number;
}): number {
  try {
    const price = modelPrice(input.model, currentJob()?.prices);
    return (input.inputBytes * price.input) / 1_000_000;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/**
 * Rejects when `signal` aborts or `ms` pass, whichever is first. `cancelled()` says it was this
 * that ended the wait (not the thing waited on); `dispose` removes the timer and listener.
 */
function cancellation(
  signal: AbortSignal | undefined,
  ms: number,
): {
  promise: Promise<never>;
  cancelled: () => boolean;
  dispose: () => void;
} {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  let cancelled = false;
  const promise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      cancelled = true;
      reject(
        new AppError('BUDGET_EXHAUSTED', 'The spend gate did not answer.', {
          details: { reason: 'spend_gate' },
        }),
      );
    }, ms);
    if (signal) {
      onAbort = () => {
        cancelled = true;
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError'),
        );
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  // The race may end first; an unhandled rejection from the loser must not escape.
  promise.catch(() => undefined);
  return {
    promise,
    cancelled: () => cancelled,
    dispose: () => {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    },
  };
}
