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
    extra?: { docId?: string },
  ): Promise<void>;
  /** `failed` with the error, or `aborted` when the request's reader had already gone. */
  fail(error: unknown, extra?: { docId?: string }): Promise<void>;
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
  const end: JobSettlement['end'] = async (outcome, error, extra) => {
    if (ended) return;
    ended = true;
    const event: JobEnd = {
      job: {
        ...job,
        ...(extra?.docId === undefined ? {} : { docId: extra.docId }),
      },
      ref: job.ref,
      outcome,
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
    end,
    fail: (error, extra) =>
      input.signal?.aborted
        ? end('aborted', undefined, extra)
        : end('failed', error, extra),
  };
}
