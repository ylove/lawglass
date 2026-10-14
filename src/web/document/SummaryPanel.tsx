import { useEffect, useState } from 'react';
import type { AnswerResult, DocDetail } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { AnswerText, type OpenCitation } from '../AnswerText.js';
import { errorMessage } from '../errors.js';
import { ScenarioStrip } from './ScenarioStrip.js';

/** The server starts the run on the first look, so this is how often we ask again. */
export const SUMMARY_POLL_MS = 2000;
/** Give up waiting after two minutes; the "Summarize this bill" chip still works. */
export const SUMMARY_MAX_WAIT_MS = 120_000;

type State =
  | { kind: 'loading' }
  | { kind: 'pending' }
  | { kind: 'cached'; answer: AnswerResult }
  | { kind: 'disabled' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

/**
 * What a reader sees on arrival: the one-line preview straight away, then the plain-language
 * summary once the server has it. The panel is its own polite live region, so the arrival of the
 * summary is announced without adding a second `role="status"` to the page.
 */
export function SummaryPanel({
  api,
  docId,
  preview,
  officialSummary,
  publicMode,
  onOpenSection,
  pollMs = SUMMARY_POLL_MS,
  maxWaitMs = SUMMARY_MAX_WAIT_MS,
}: {
  api: ApiClient;
  docId: string;
  preview: DocDetail['preview'];
  officialSummary: NonNullable<DocDetail['history']>['officialSummary'];
  publicMode: boolean;
  onOpenSection: OpenCitation;
  pollMs?: number;
  maxWaitMs?: number;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const started = Date.now();
    const look = () => {
      api
        .getSummary(docId)
        .then((r) => {
          if (!live) return;
          if (r.status === 'cached' && r.answer) {
            setState({ kind: 'cached', answer: r.answer });
          } else if (r.status === 'disabled') {
            setState({ kind: 'disabled' });
          } else if (Date.now() - started >= maxWaitMs) {
            setState({ kind: 'timeout' });
          } else {
            setState({ kind: 'pending' });
            timer = setTimeout(look, pollMs);
          }
        })
        .catch((e: unknown) => {
          if (live) setState({ kind: 'error', message: errorMessage(e) });
        });
    };
    look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, docId, pollMs, maxWaitMs]);

  const cached = state.kind === 'cached' ? state.answer : null;
  const chipHint = !publicMode;
  return (
    <>
      <section
        aria-labelledby="summary-title"
        aria-live="polite"
        className="card summary"
      >
        <h3 id="summary-title">In brief</h3>
        {cached ? (
          <div className="summary-text">
            <AnswerText
              text={cached.text}
              citations={cached.citations}
              onOpenCitation={onOpenSection}
              citationLabel="Summary source"
            />
          </div>
        ) : (
          // Never an empty page: the preview (or at least a placeholder) is always here.
          <p className="summary-preview">
            {preview?.text ?? 'A plain-language summary is on its way.'}
          </p>
        )}
        {(state.kind === 'loading' || state.kind === 'pending') && (
          <p className="muted summary-note">
            Writing a plain-language summary…
          </p>
        )}
        {state.kind === 'timeout' && (
          <p className="muted summary-note">
            The summary is taking longer than expected.
            {chipHint && " Choose 'Summarize this bill' to ask for it now."}
          </p>
        )}
        {state.kind === 'error' && (
          <p className="muted summary-note">
            The summary could not be loaded. {state.message}
          </p>
        )}
        {state.kind === 'disabled' && chipHint && (
          <p className="muted summary-note">
            Choose 'Summarize this bill' for a full summary.
          </p>
        )}
        {cached && (
          <p className="muted summary-note">
            Written from the bill's own text.
          </p>
        )}
        {officialSummary && (
          <details className="official-summary">
            <summary>Official summary ({officialSummary.source})</summary>
            {/* Untrusted text from an outside source: rendered as plain text only. */}
            <p>{officialSummary.text}</p>
            <a
              href={officialSummary.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              Read it at the source
            </a>
          </details>
        )}
      </section>
      {cached?.scenario && (
        <ScenarioStrip
          scenario={cached.scenario}
          onOpenSection={onOpenSection}
        />
      )}
    </>
  );
}
