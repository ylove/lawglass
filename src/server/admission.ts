/**
 * The admission seam (ADR 0018, section 3). A host decides, before any paid model work starts,
 * whether the work may run, needs a confirmed quote, or is refused. This repository knows
 * nothing about money: the host sees an estimate and answers allow, quote or deny.
 */
import type { Context } from 'hono';
import type { BillEstimate, FeatureEstimate } from '../core/cost/index.js';
import type { JobBudget, JobKind } from '../core/cost/index.js';
import { AppError, type ErrorPayload } from '../core/model/index.js';

export type { JobBudget, JobKind };

export interface AdmissionJob {
  kind: JobKind;
  docId?: string;
  /** From the request: a quote the reader confirmed. For ingest only a live quote from this server is passed. */
  quoteId?: string;
  chipId?: string;
  /** Computed before any model call. A whole-bill estimate for ingest, one answer-like call otherwise. */
  estimate: BillEstimate | FeatureEstimate;
  /** Ingest only: the estimate for every configured tier, by tier name. */
  estimates?: Record<string, BillEstimate>;
}

export type Admission =
  | { allow: true; budget?: JobBudget }
  /** HTTP 402 with the host's opaque quote object, which the SPA shows and resubmits. */
  | { allow: false; status: 402; quote: unknown }
  | { allow: false; status: 403 | 429; error: ErrorPayload };

export type AdmissionHook = (
  c: Context,
  job: AdmissionJob,
) => Promise<Admission>;

/** Models for a job. Applied through `runtime.providerFor`. */
export type ModelForHook = (job: AdmissionJob) => {
  answer?: string;
  extract?: string;
};

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
  | { allowed: true; budget: JobBudget | undefined }
  | { allowed: false; response: Response } {
  const d = decision as Partial<Admission> | null | undefined;
  const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  if (d && typeof d === 'object' && d.allow === true) {
    const budget = (d as { budget?: unknown }).budget;
    if (budget === undefined) return { allowed: true, budget: undefined };
    // A malformed budget is a host bug; fail the request rather than run unbounded.
    if (!validBudget(budget)) throw new Error('Invalid job budget.');
    return { allowed: true, budget };
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

function validBudget(value: unknown): value is JobBudget {
  if (typeof value !== 'object' || value === null) return false;
  const { dollars, tokens } = value as JobBudget;
  const ok = (n: unknown): boolean =>
    n === undefined || (typeof n === 'number' && Number.isFinite(n) && n >= 0);
  return ok(dollars) && ok(tokens);
}
