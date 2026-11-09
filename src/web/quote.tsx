// The quote dialog (ADR 0018, section 8). When a host's server answers 402, the reader sees what
// the work involves and confirms or cancels; confirming sends the same request again with the
// quote's id. This repository never computes or shows a price of its own: any price text comes
// from the host, in `quote.display`.
import { useEffect, useId, useRef } from 'react';
import { z } from 'zod';
import type { ApiClient } from './api.js';
import { emitEvent } from './events.js';
import { ApiError } from './sse.js';

/** What the dialog reads from the host's quote object. Everything is optional and unknown keys are ignored. */
const QuoteView = z.object({
  quoteId: z.string().min(1).max(128).optional(),
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
export function withQuoteConfirmation(
  api: ApiClient,
  confirm: Confirm,
): ApiClient {
  async function* retrying<T>(
    run: (quoteId: string | undefined) => AsyncIterable<T>,
  ): AsyncGenerator<T> {
    try {
      yield* run(undefined);
      return;
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'PAYMENT_REQUIRED') throw e;
      const quote = parseQuote(e.quote);
      emitEvent('quote_shown');
      if (!(await confirm(quote))) throw new ApiError('CANCELLED', CANCELLED);
      emitEvent('quote_confirmed');
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

const number = new Intl.NumberFormat('en-US');

function factLines(quote: QuoteView): string[] {
  const f = quote.facts;
  if (!f) return [];
  const lines: string[] = [];
  if (f.pages != null)
    lines.push(`${number.format(f.pages)} ${f.pages === 1 ? 'page' : 'pages'}`);
  if (f.sections !== undefined)
    lines.push(
      `${number.format(f.sections)} ${f.sections === 1 ? 'section' : 'sections'}`,
    );
  if (f.tokens !== undefined)
    // Four characters to a token and about five to a word, rounded: a size, not a count.
    lines.push(`about ${number.format(Math.round(f.tokens * 0.8))} words`);
  return lines;
}

export function QuoteDialog({
  quote,
  onConfirm,
  onCancel,
}: {
  quote: QuoteView;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    confirmRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const facts = factLines(quote);
  return (
    <div
      className="drawer-backdrop quote-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="quote-dialog"
      >
        <h2 id={titleId}>Confirm before we start</h2>
        {facts.length > 0 && <p>This bill is {facts.join(', ')}.</p>}
        {quote.display && <p className="quote-display">{quote.display}</p>}
        <div className="quote-actions">
          <button
            ref={confirmRef}
            type="button"
            className="btn primary"
            onClick={onConfirm}
          >
            Confirm
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
