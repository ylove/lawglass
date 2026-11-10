/**
 * Settlement for admitted jobs (ADR 0018, part C). A host that holds funds at admission needs
 * to hear how each job ended, exactly once, so it can capture on `ok` and release on `failed`
 * or `aborted`. The guard here is what makes "exactly once" true: every route that can end a
 * job calls `end`, in any order and any number of times, and the host hears the first call.
 *
 * A process that dies mid-job ends it without a callback. Hosts must expire holds.
 */
import type { JobScope, JobContext } from '../core/cost/index.js';
import type { ErrorPayload } from '../core/model/index.js';
import type { JobEnd, JobOutcome } from './admission.js';

export interface JobSettlement {
  /** Ends the job. Only the first call per job reaches the host. Never rejects. */
  end(
    outcome: JobOutcome,
    error?: unknown,
    extra?: { docId?: string; granted?: 'used' | 'unused' },
  ): Promise<void>;
  /**
   * Like `end`, but tells the caller SYNCHRONOUSLY whether this call won the exactly-once race
   * (`won`), so work that must follow only a winning end can run in the same tick.
   */
  tryEnd(
    outcome: JobOutcome,
    error?: unknown,
    extra?: { docId?: string; granted?: 'used' | 'unused' },
  ): { won: boolean; done: Promise<void> };
  /** `failed` with the error, or `aborted` when the request's reader had already gone. */
  fail(error: unknown, extra?: { docId?: string }): Promise<void>;
  /** Some of the answer reached the reader (a streamed token or frame). */
  markDelivered(): void;
}

/** A job the host admitted: the scope to run it in, and how to tell the host it ended. */
export interface Admitted {
  scope: JobScope;
  /** Present only when the host asked to hear about job ends (`onJobEnd`). */
  settlement: JobSettlement | undefined;
}

export function createSettlement(input: {
  context: JobContext;
  onJobEnd: (end: JobEnd) => void | Promise<void>;
  payload: (error: unknown) => ErrorPayload;
  /** The request's own signal: set when the reader disconnected. */
  signal?: AbortSignal | undefined;
}): JobSettlement {
  // Taken now: a later top-up of a shared scope changes its job id, and this job's end must
  // still name the job that was admitted.
  const job: JobContext = { ...input.context };
  let ended = false;
  let partial = false;
  const tryEnd: JobSettlement['tryEnd'] = (outcome, error, extra) => {
    if (ended) return { won: false, done: Promise.resolve() };
    ended = true;
    return { won: true, done: deliver(outcome, error, extra) };
  };
  const end: JobSettlement['end'] = (outcome, error, extra) =>
    tryEnd(outcome, error, extra).done;
  const deliver = async (
    outcome: JobOutcome,
    error: unknown,
    extra: { docId?: string; granted?: 'used' | 'unused' } | undefined,
  ): Promise<void> => {
    const event: JobEnd = {
      job: {
        ...job,
        ...(extra?.docId === undefined ? {} : { docId: extra.docId }),
      },
      ref: job.ref,
      outcome,
      delivered: outcome === 'ok' ? 'full' : partial ? 'partial' : 'none',
      ...(outcome === 'ok' && extra?.granted ? { granted: extra.granted } : {}),
      ...(error === undefined || outcome === 'ok'
        ? {}
        : { error: input.payload(error) }),
    };
    try {
      await input.onJobEnd(event);
    } catch {
      /* The host's bookkeeping failing must not change what the reader sees. */
    }
  };
  return {
    markDelivered: () => {
      partial = true;
    },
    end,
    tryEnd,
    fail: (error, extra) =>
      input.signal?.aborted
        ? end('aborted', undefined, extra)
        : end('failed', error, extra),
  };
}
