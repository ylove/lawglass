/**
 * The host hook behind `POST /api/docs/:docId/question-quote` (issue #429). A host that charges
 * per question says, before one is asked, what each answer mode would cost it, in its own units.
 */
import type { Context } from 'hono';
import type { QuestionQuote } from '../core/answer/question-quote.js';
import type { QuestionCeiling } from '../core/cost/index.js';

export {
  QuestionQuote,
  QuestionQuoteResponse,
} from '../core/answer/question-quote.js';

export interface QuestionQuoteRequest {
  docId: string;
  /** The reader's id: the signed-in account in auth mode, `local` otherwise. */
  reader: string;
  /** The model tier the reader's questions run on, as in `AdmissionJob.tier`. */
  tier?: string;
  /**
   * The most one question can cost in each mode on this document, tier and the server's output
   * caps, from `questionCeiling`. A host turns `dollars` into its units; no billing logic here.
   */
  worstCase: QuestionCeiling;
}

/** Return `undefined` to say there is nothing to show (the reader asks directly). */
export type QuestionQuoteHook = (
  request: QuestionQuoteRequest,
  c: Context,
) => Promise<QuestionQuote | undefined>;
