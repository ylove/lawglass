// The quote flow without any UI: parse the host's quote and retry a 402 once after the reader
// confirms (ADR 0018, section 8). Kept apart from the dialog so the server tests can drive the
// same retry logic the browser uses.
import { z } from 'zod';
import type { ApiClient } from './api.js';
import { ApiError } from './sse.js';

/** The server accepts only these ids; hosts must use base64url (no '+', '/' or '='). */
const QUOTE_ID = /^[A-Za-z0-9_-]{1,128}$/;
export const BAD_QUOTE_ID =
  'This quote cannot be confirmed because its id is not in a supported format. Please contact support.';

/** What the dialog reads from the host's quote object. Everything is optional and unknown keys are ignored. */
const QuoteView = z.object({
  quoteId: z.string().regex(QUOTE_ID).optional().catch(undefined),
  /** Price or terms text, written by the host. Shown as plain text. */
  display: z.string().max(500).optional(),
  facts: z
    .object({
      pages: z.number().nullable().optional(),
      sections: z.number().optional(),
      tokens: z.number().optional(),
      mode: z.string().optional(),
      units: z.number().optional(),
    })
    .optional(),
});
export type QuoteView = z.infer<typeof QuoteView>;

export function parseQuote(raw: unknown): QuoteView {
  const parsed = QuoteView.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

export const CANCELLED = 'You cancelled that request.';

type Confirm = (quote: QuoteView) => Promise<boolean>;

/**
 * Retries a request once, with the quote's id, after the reader confirms a 402. Only ingest and
 * questions can be quoted; every other call passes through untouched.
 */
export function withQuoteFlow(
  api: ApiClient,
  confirm: Confirm,
  events: { shown: () => void; confirmed: () => void } = {
    shown: () => undefined,
    confirmed: () => undefined,
  },
): ApiClient {
  async function* retrying<T>(
    run: (quoteId: string | undefined) => AsyncIterable<T>,
  ): AsyncGenerator<T> {
    try {
      yield* run(undefined);
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'PAYMENT_REQUIRED') throw e;
      const rawId =
        typeof e.quote === 'object' && e.quote !== null && 'quoteId' in e.quote
          ? e.quote.quoteId
          : undefined;
      // Sending an id the server would refuse as malformed only hides the real reason.
      if (
        rawId !== undefined &&
        !(typeof rawId === 'string' && QUOTE_ID.test(rawId))
      )
        throw new ApiError('INVALID_QUOTE', BAD_QUOTE_ID);
      const quote = parseQuote(e.quote);
      events.shown();
      if (!(await confirm(quote))) throw new ApiError('CANCELLED', CANCELLED);
      events.confirmed();
      yield* run(quote.quoteId);
    }
  }
  return {
    ...api,
    ingest: (req, signal) =>
      retrying((quoteId) =>
        api.ingest(quoteId ? { ...req, quoteId } : req, signal),
      ),
    ask: (docId, req, signal) =>
      retrying((quoteId) =>
        api.ask(docId, quoteId ? { ...req, quoteId } : req, signal),
      ),
  };
}
