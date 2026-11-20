// Asked before a typed question when the host's quote says reading the whole bill costs more
// than a focused answer (issue #429). Units are the host's own and opaque here: this file only
// shows the numbers it is given, with the label the host chose.
import { useEffect, useId, useRef } from 'react';
import type { AnswerMode } from '../../core/answer/modes.js';
import type { QuestionQuote } from '../../core/answer/question-quote.js';

const number = new Intl.NumberFormat('en-US');

/** "1 question", "4 questions". The host names the unit in the plural; one drops a trailing "s". */
function amount(count: number, unit: string | undefined): string {
  const plural = unit ?? 'units';
  const word =
    count === 1 && plural.endsWith('s') ? plural.slice(0, -1) : plural;
  return `${number.format(count)} ${word}`;
}

/** The choice only exists when a whole-bill read costs more, so a quote can be tested for it. */
export function needsModeChoice(quote: QuestionQuote | null): boolean {
  return quote?.whole !== undefined && quote.whole.units > quote.focused.units;
}

const FOCUSABLE = 'button:not([disabled])';

export function QuestionModeDialog({
  quote,
  onChoose,
  onCancel,
}: {
  quote: QuestionQuote;
  onChoose: (mode: Exclude<AnswerMode, 'auto'>) => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const bodyId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    // Focus lands on the title so a screen reader reads it with the description, and so Enter
    // cannot spend anything before the reader has chosen.
    title.current?.focus();
    return () => {
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const whole = quote.whole?.units ?? 0;
  // "4 of your 30 questions" when the host says what is left, else "4 questions".
  const wholeUses =
    quote.remaining === undefined
      ? amount(whole, quote.unit)
      : `${number.format(whole)} of your ${amount(quote.remaining, quote.unit)}`;
  return (
    <div
      className="drawer-backdrop quote-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          onCancel();
          return;
        }
        if (e.key !== 'Tab') return;
        // aria-modal hides the page from a screen reader; keep Tab inside it as well.
        const stops = dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (!stops || stops.length === 0) return;
        const first = stops[0];
        const last = stops[stops.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        className="quote-dialog"
      >
        <h2 id={titleId} ref={title} tabIndex={-1}>
          This question needs a full read of the bill
        </h2>
        <p id={bodyId}>
          Reading the whole bill uses {wholeUses}. A focused answer, drawn from
          the most relevant parts, uses{' '}
          {amount(quote.focused.units, quote.unit)}.
        </p>
        <div className="quote-actions mode-actions">
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              onChoose('whole');
            }}
          >
            Read the whole bill ({amount(whole, quote.unit)})
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              onChoose('focused');
            }}
          >
            Get a focused answer ({amount(quote.focused.units, quote.unit)})
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
