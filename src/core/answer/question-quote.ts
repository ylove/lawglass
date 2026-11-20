/**
 * The question quote a host's hook returns and the web UI reads (issue #429). The numbers are
 * the host's own opaque units: this repository never learns what a unit is worth.
 */
import { z } from 'zod';

/** One mode's price in the host's units (questions, credits, cents: this server does not care). */
const Units = z.object({ units: z.number().nonnegative() });

/** What a host's hook returns. */
export const QuestionQuote = z.object({
  /** Absent when the bill is too long to read whole, so only a focused answer exists. */
  whole: Units.optional(),
  focused: Units,
  /** What the reader has left, in the same units. Shown, never enforced here. */
  remaining: z.number().nonnegative().optional(),
  /** What the units are called, as a plural noun for the reader: "questions", "credits". */
  unit: z.string().trim().min(1).max(40).optional(),
});
export type QuestionQuote = z.infer<typeof QuestionQuote>;

/** `POST /api/docs/:docId/question-quote`: `quote` is null when the server has no hook or it has no quote. */
export const QuestionQuoteResponse = z.object({
  quote: QuestionQuote.nullable(),
});
export type QuestionQuoteResponse = z.infer<typeof QuestionQuoteResponse>;
