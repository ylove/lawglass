// The quote dialog (ADR 0018, section 8). When a host's server answers 402, the reader sees what
// the work involves and confirms or cancels; confirming sends the same request again with the
// quote's id. This repository never computes or shows a price of its own: any price text comes
// from the host, in `quote.display`.
import { useEffect, useId, useRef } from 'react';
import type { ApiClient } from './api.js';
import { emitEvent } from './events.js';
import { withQuoteFlow, type QuoteView } from './quote-flow.js';

export { CANCELLED, parseQuote, type QuoteView } from './quote-flow.js';

/** The quote flow, announcing the dialog and the reader's confirmation as reader events. */
export function withQuoteConfirmation(
  api: ApiClient,
  confirm: (quote: QuoteView) => Promise<boolean>,
): ApiClient {
  return withQuoteFlow(api, confirm, {
    shown: () => {
      emitEvent('quote_shown');
    },
    confirmed: () => {
      emitEvent('quote_confirmed');
    },
  });
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
