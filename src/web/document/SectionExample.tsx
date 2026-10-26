import { useEffect, useState } from 'react';
import type { Scenario, SectionBrief } from '../../core/model/index.js';
import { NO_EXAMPLE_NOTE } from '../../core/breakdown/notes.js';
import type { ApiClient } from '../api.js';
import { errorMessage } from '../errors.js';
import { ScenarioStrip } from './ScenarioStrip.js';

/** The server long-polls, so this is only the pause between looks after a `pending`. */
export const EXAMPLE_POLL_MS = 1500;
/** Give up on one example after this long and offer to try again. */
export const EXAMPLE_MAX_WAIT_MS = 90_000;

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'ok'; scenario: Scenario; open: boolean }
  | { kind: 'none'; note: string }
  | { kind: 'disabled' }
  | { kind: 'error'; message: string };

/**
 * The example control for one part of the bill (#277). A part whose brief said an example is
 * possible gets a "Show an example" button. Pressing it asks the server, which draws the example
 * (or already has), while a visible loader says so. A part with nothing to illustrate shows a
 * one-line note instead of a button. The note text always comes from our code, not the model.
 */
export function SectionExample({
  api,
  docId,
  brief,
  label,
  onOpenSection,
  pollMs = EXAMPLE_POLL_MS,
  maxWaitMs = EXAMPLE_MAX_WAIT_MS,
}: {
  api: ApiClient;
  docId: string;
  brief: SectionBrief;
  /** Names this part for assistive technology ("Section 4(b)"). */
  label: string;
  onOpenSection: (sectionId: string, trigger: HTMLElement) => void;
  pollMs?: number;
  maxWaitMs?: number;
}) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const regionId = `example-${brief.sectionId.replace(/[^A-Za-z0-9_-]/g, '-')}`;

  useEffect(() => {
    if (attempt === 0) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const begun = Date.now();
    const look = () => {
      api
        .getSectionExample(docId, brief.sectionId, controller.signal)
        .then((r) => {
          if (!live) return;
          if (r.status === 'ok' && r.scenario) {
            setState({ kind: 'ok', scenario: r.scenario, open: true });
          } else if (r.status === 'none') {
            setState({ kind: 'none', note: r.note ?? NO_EXAMPLE_NOTE });
          } else if (r.status === 'disabled') {
            setState({ kind: 'disabled' });
          } else if (Date.now() - begun >= maxWaitMs) {
            setState({
              kind: 'error',
              message: 'Drawing this example is taking longer than expected.',
            });
          } else {
            timer = setTimeout(look, pollMs);
          }
        })
        .catch((e: unknown) => {
          if (!live) return;
          setState({ kind: 'error', message: errorMessage(e) });
        });
    };
    look();
    return () => {
      live = false;
      clearTimeout(timer);
      controller.abort();
    };
  }, [api, docId, brief.sectionId, pollMs, maxWaitMs, attempt]);

  if (brief.example === 'none')
    return <p className="muted brief-note">{NO_EXAMPLE_NOTE}</p>;

  const ask = () => {
    setState({ kind: 'loading' });
    setAttempt((n) => n + 1);
  };

  return (
    <div className="brief-example">
      {(state.kind === 'idle' || state.kind === 'error') && (
        <button
          type="button"
          className="btn brief-example-btn"
          aria-describedby={
            state.kind === 'error' ? `${regionId}-err` : undefined
          }
          onClick={ask}
        >
          {state.kind === 'error' ? 'Try the example again' : 'Show an example'}
          <span className="sr-only"> for {label}</span>
        </button>
      )}
      {state.kind === 'ok' && (
        <button
          type="button"
          className="btn brief-example-btn"
          aria-expanded={state.open}
          aria-controls={regionId}
          onClick={() => {
            setState({ ...state, open: !state.open });
          }}
        >
          {state.open ? 'Hide example' : 'Show example'}
          <span className="sr-only"> for {label}</span>
        </button>
      )}
      <div id={regionId} aria-live="polite">
        {state.kind === 'loading' && (
          <p className="example-loader muted">
            <span className="spinner" aria-hidden="true" />
            Drawing an example…
          </p>
        )}
        {state.kind === 'ok' && state.open && (
          <ScenarioStrip
            nested
            scenario={state.scenario}
            onOpenSection={onOpenSection}
          />
        )}
        {state.kind === 'none' && (
          <p className="muted brief-note">{state.note}</p>
        )}
        {state.kind === 'disabled' && (
          <p className="muted brief-note">
            Examples are not available on this server.
          </p>
        )}
        {state.kind === 'error' && (
          <p id={`${regionId}-err`} role="alert" className="error brief-note">
            {state.message}
          </p>
        )}
      </div>
    </div>
  );
}
