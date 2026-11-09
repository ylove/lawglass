/**
 * The admission seam (ADR 0018, section 3). A host decides, before any paid model work starts,
 * whether the work may run, needs a confirmed quote, or is refused. This repository knows
 * nothing about money: the host sees an estimate and answers allow, quote or deny.
 */
import type { Context } from 'hono';
import type { QuoteFacts } from './quotes.js';
import type {
  BillEstimate,
  FeatureEstimate,
  JobBudget,
  JobContext,
  JobKind,
} from '../core/cost/index.js';
import { AppError, type ErrorPayload } from '../core/model/index.js';

export type { JobBudget, JobKind };

export interface AdmissionJob {
  kind: JobKind;
  docId?: string;
  /** From the request, as sent: the id of a quote the reader confirmed. Opaque to this server (1 to 128 of A-Za-z0-9_-). */
  quoteId?: string;
  /** Ingest only: set when `quoteId` is also a live quote this server issued to this reader for this address. */
  serverQuote?: {
    contentHash: string;
    facts: QuoteFacts;
    estimates: Record<string, BillEstimate>;
  };
  /**
   * Ingest only: true when this document's summary and breakdown are already generated for the
   * reader's tier, so no new generation will be started and the admission budget would go unused.
   * The host may decide not to charge, or to charge only for the cached read.
   */
  docComplete?: boolean;
  /** The model tier the reader's work will run on, as `answer+extract` model names ('default' when `modelFor` chose none). */
  tier?: string;
  chipId?: string;
  /** Computed before any model call. A whole-bill estimate for ingest, one answer-like call otherwise. */
  estimate: BillEstimate | FeatureEstimate;
  /** Ingest only: the estimate for every configured tier, by tier name. */
  estimates?: Record<string, BillEstimate>;
}

export type Admission =
  /**
   * `ref` is the host's opaque reference for this admission (1 to 128 of `A-Za-z0-9_-`, for
   * example the id of a hold). It comes back in every `UsageEvent.job.ref` and in `onJobEnd`.
   * An invalid `ref` fails the request with a 500 before any work starts.
   */
  | { allow: true; budget?: JobBudget; ref?: string }
  /** HTTP 402 with the host's opaque quote object, which the SPA shows and resubmits. */
  | { allow: false; status: 402; quote: unknown }
  | { allow: false; status: 403 | 429; error: ErrorPayload };

export type AdmissionHook = (
  c: Context,
  job: AdmissionJob,
) => Promise<Admission>;

export type JobOutcome = 'ok' | 'failed' | 'aborted';

/**
 * What `onJobEnd` receives, once per admitted job (ADR 0018, part C). `job` is the context the
 * job was admitted with; `error` is the plain-language payload of a failure.
 */
export interface JobEnd {
  job: JobContext;
  ref: string | undefined;
  outcome: JobOutcome;
  /**
   * What the reader actually received: `full` for `ok`; `partial` when answer text or frames
   * were streamed before the job was aborted or failed; `none` otherwise. A reader can leave a
   * stream just before its end, so a host should keep what it held unless this is `none`.
   */
  delivered: 'none' | 'partial' | 'full';
  /**
   * Ingest only, with `ok`: whether this admission's budget was put to use (`used`) or no
   * generation remained to do for the reader's tier (`unused`), so the host can refund a grant.
   */
  granted?: 'used' | 'unused';
  error?: ErrorPayload;
}

/** The shape of a valid `ref`. */
export const REF_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Models for a job. Applied through `runtime.providerFor`. */
export type ModelForHook = (
  job: AdmissionJob,
  c: Context,
) => {
  answer?: string;
  extract?: string;
};

/** What a host persisted for a document's background generation: the REMAINING budget, the tier's models, the job id. */
export interface SavedScope {
  budget?: JobBudget;
  models?: { answer?: string; extract?: string };
  jobId?: string;
}
export type BackgroundScopeHook = (
  docId: string,
  tier: string,
  models: { answer?: string; extract?: string } | undefined,
) => Promise<SavedScope | undefined>;

/** Thrown when admission refuses; `app.onError` turns it into the response. */
export class AdmissionRefused extends AppError {
  constructor(readonly response: Response) {
    // The code only labels the server's own log line; the response body carries the host's.
    super(
      response.status === 402
        ? 'PAYMENT_REQUIRED'
        : response.status === 429
          ? 'RATE_LIMITED'
          : 'PUBLIC_MODE_FORBIDDEN',
      'Admission refused.',
    );
    this.name = 'AdmissionRefused';
  }
}

const REFUSAL_MESSAGES: Record<403 | 429, string> = {
  403: 'This request is not allowed.',
  429: 'Too many requests. Please wait and try again.',
};

/**
 * Turns a host's decision into either a budget to enforce or a refusal response. Anything that is
 * not a clearly valid decision is a refusal, so a buggy host fails closed.
 */
export function interpretAdmission(
  decision: unknown,
):
  | { allowed: true; budget: JobBudget | undefined; ref: string | undefined }
  | { allowed: false; response: Response } {
  const d = decision as Partial<Admission> | null | undefined;
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (d && typeof d === 'object' && d.allow === true) {
    const budget = (d as { budget?: unknown }).budget;
    const ref = (d as { ref?: unknown }).ref;
    // A malformed reference is a host bug; fail the request before any work rather than let
    // the host's settlement drift from what ran.
    if (
      ref !== undefined &&
      (typeof ref !== 'string' || !REF_PATTERN.test(ref))
    )
      throw new Error('Invalid admission ref.');
    if (budget === undefined) return { allowed: true, budget: undefined, ref };
    // A malformed budget is a host bug; fail the request rather than run unbounded.
    if (!validBudget(budget)) throw new Error('Invalid job budget.');
    return { allowed: true, budget, ref };
  }
  if (d && typeof d === 'object' && d.allow === false) {
    if (d.status === 402)
      return {
        allowed: false,
        response: json(
          {
            error: {
              code: 'PAYMENT_REQUIRED',
              message: 'Confirm the quote to continue.',
            },
            quote: (d as { quote?: unknown }).quote ?? null,
          },
          402,
        ),
      };
    if (d.status === 403 || d.status === 429) {
      const error = (d as { error?: Partial<ErrorPayload> }).error;
      return {
        allowed: false,
        response: json(
          {
            error: {
              code: typeof error?.code === 'string' ? error.code : 'FORBIDDEN',
              message:
                typeof error?.message === 'string'
                  ? error.message
                  : REFUSAL_MESSAGES[d.status],
            },
          },
          d.status,
        ),
      };
    }
  }
  return {
    allowed: false,
    response: json(
      { error: { code: 'FORBIDDEN', message: REFUSAL_MESSAGES[403] } },
      403,
    ),
  };
}

export function validBudget(value: unknown): value is JobBudget {
  if (typeof value !== 'object' || value === null) return false;
  const { dollars, tokens } = value as JobBudget;
  const ok = (n: unknown): boolean =>
    n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
  return ok(dollars) && ok(tokens);
}
