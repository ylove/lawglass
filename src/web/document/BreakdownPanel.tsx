import { useEffect, useRef, useState } from 'react';
import type { SectionBrief } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { AnswerText, type OpenCitation } from '../AnswerText.js';
import { ApiError } from '../sse.js';
import { SERVER_COOL_DOWN_MS } from './cool-down.js';
import { SectionExample } from './SectionExample.js';

/** How often to ask again while the server is still reading the sections. */
export const BREAKDOWN_POLL_MS = 2000;
/**
 * Give up after six minutes without progress; the summary above and the questions below still
 * work. The server may wait up to three minutes for the summary before it starts reading, so the
 * clock restarts whenever a new part arrives.
 */
export const BREAKDOWN_MAX_WAIT_MS = 360_000;
/** A long bill shows this many cards, then a button for the rest. */
export const INITIAL_VISIBLE_BRIEFS = 6;

type State =
  | { kind: 'loading' }
  | { kind: 'pending'; briefs: readonly SectionBrief[] }
  | { kind: 'cached'; briefs: readonly SectionBrief[]; omitted: number }
  | { kind: 'disabled' }
  | { kind: 'timeout'; briefs: readonly SectionBrief[] }
  /** The run failed; one automatic look again is scheduled for after the server's cool-down. */
  | { kind: 'cooling'; briefs: readonly SectionBrief[] }
  | { kind: 'error'; briefs: readonly SectionBrief[] };

function partLabel(brief: SectionBrief): string {
  return brief.num ? `Section ${brief.num}` : (brief.heading ?? 'This part');
}

function BriefCard({
  api,
  docId,
  brief,
  onOpenSection,
  examplePollMs,
  exampleMaxWaitMs,
  coolDownMs,
}: {
  api: ApiClient;
  docId: string;
  brief: SectionBrief;
  onOpenSection: OpenCitation;
  examplePollMs?: number | undefined;
  exampleMaxWaitMs?: number | undefined;
  coolDownMs: number;
}) {
  const label = partLabel(brief);
  const titleId = `brief-${brief.sectionId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <li>
      <article aria-labelledby={titleId} className="brief-card">
        <h4 id={titleId}>
          <span className="brief-num">{label}</span>
          {brief.num && brief.heading && (
            <span className="brief-heading">{brief.heading}</span>
          )}
        </h4>
        <div className="brief-text">
          <AnswerText
            text={brief.text}
            citations={brief.citations}
            onOpenCitation={onOpenSection}
            citationLabel={`${label} source`}
          />
        </div>
        <SectionExample
          api={api}
          docId={docId}
          brief={brief}
          label={label}
          onOpenSection={onOpenSection}
          coolDownMs={coolDownMs}
          {...(examplePollMs === undefined ? {} : { pollMs: examplePollMs })}
          {...(exampleMaxWaitMs === undefined
            ? {}
            : { maxWaitMs: exampleMaxWaitMs })}
        />
      </article>
    </li>
  );
}

function Skeleton({ count }: { count: number }) {
  return (
    <ul className="brief-list brief-skeleton" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="brief-card">
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line" />
          <span className="skeleton-line skeleton-short" />
        </li>
      ))}
    </ul>
  );
}

/**
 * "Section by section" (#276): what each substantive part of the bill does, in a few plain
 * sentences with citations, and under each a way to see an example. The server starts the run on
 * the first look; this polls like the summary does, and shows parts as they are finished.
 */
export function BreakdownPanel({
  api,
  docId,
  enabled,
  onOpenSection,
  pollMs = BREAKDOWN_POLL_MS,
  maxWaitMs = BREAKDOWN_MAX_WAIT_MS,
  examplePollMs,
  exampleMaxWaitMs,
  coolDownMs = SERVER_COOL_DOWN_MS,
}: {
  api: ApiClient;
  docId: string;
  /** `ClientConfig.breakdownEnabled`: false on a public server, where nothing is started. */
  enabled: boolean;
  onOpenSection: OpenCitation;
  pollMs?: number;
  maxWaitMs?: number;
  /** Test seams for each part's example polling. */
  examplePollMs?: number;
  exampleMaxWaitMs?: number;
  /** How long to wait out the server's cool-down after a failed run (test seam). */
  coolDownMs?: number;
}) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [showAll, setShowAll] = useState(false);
  // The parts already shown, kept so a failure never takes them away.
  const shown = useRef<readonly SectionBrief[]>([]);
  // One failed run is retried on its own; a second failure asks the reader.
  const autoRetried = useRef(false);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Restarts whenever a new part arrives (see BREAKDOWN_MAX_WAIT_MS).
    let lastProgress = Date.now();
    const look = () => {
      api
        .getBreakdown(docId)
        .then((r) => {
          if (!live) return;
          if ((r.briefs?.length ?? 0) > shown.current.length) {
            lastProgress = Date.now();
            shown.current = r.briefs ?? [];
          }
          if (r.status === 'cached' && r.briefs && r.briefs.length > 0) {
            setState({
              kind: 'cached',
              briefs: r.briefs,
              omitted: r.omitted ?? 0,
            });
          } else if (r.status === 'disabled' || r.status === 'cached') {
            setState({ kind: 'disabled' });
          } else if (Date.now() - lastProgress >= maxWaitMs) {
            setState({ kind: 'timeout', briefs: shown.current });
          } else {
            // A reply with fewer parts than are already shown (a retry restarting) must not
            // replace the cards the reader is looking at.
            setState({ kind: 'pending', briefs: shown.current });
            timer = setTimeout(look, pollMs);
          }
        })
        .catch((e: unknown) => {
          if (!live) return;
          // The server says the run failed and is cooling down: wait it out once, then look
          // again, rather than offer a retry that can only hit the cool-down. Any other failure
          // may be a blip: keep trying, and only say so on the last one.
          if (e instanceof ApiError && e.code === 'PROVIDER_ERROR') {
            if (autoRetried.current) {
              setState({ kind: 'error', briefs: shown.current });
            } else {
              autoRetried.current = true;
              setState({ kind: 'cooling', briefs: shown.current });
              timer = setTimeout(() => {
                setAttempt((n) => n + 1);
              }, coolDownMs);
            }
          } else if (Date.now() - lastProgress >= maxWaitMs)
            setState({ kind: 'error', briefs: shown.current });
          else timer = setTimeout(look, pollMs);
        });
    };
    look();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, docId, enabled, pollMs, maxWaitMs, coolDownMs, attempt]);

  if (!enabled || state.kind === 'disabled') return null;

  const retry = () => {
    autoRetried.current = false;
    setState(
      shown.current.length > 0
        ? { kind: 'pending', briefs: shown.current }
        : { kind: 'loading' },
    );
    setAttempt((n) => n + 1);
  };
  const briefs = state.kind === 'loading' ? [] : state.briefs;
  const visible = showAll ? briefs : briefs.slice(0, INITIAL_VISIBLE_BRIEFS);
  const reading = state.kind === 'loading' || state.kind === 'pending';
  const waiting = reading || state.kind === 'cooling';

  return (
    <section
      aria-labelledby="breakdown-title"
      aria-live="polite"
      aria-busy={waiting}
      className="card breakdown"
    >
      <h3 id="breakdown-title">Section by section</h3>
      {/* A polite live region (as the summary is), so the page keeps one role=status. */}
      {reading && (
        <p className="muted breakdown-note">
          {briefs.length > 0
            ? 'Reading the rest of the sections…'
            : 'Reading each section…'}
        </p>
      )}
      {visible.length > 0 && (
        <ul className="brief-list">
          {visible.map((brief) => (
            <BriefCard
              key={brief.sectionId}
              api={api}
              docId={docId}
              brief={brief}
              onOpenSection={onOpenSection}
              examplePollMs={examplePollMs}
              exampleMaxWaitMs={exampleMaxWaitMs}
              coolDownMs={coolDownMs}
            />
          ))}
        </ul>
      )}
      {briefs.length > visible.length && (
        <button
          type="button"
          className="btn breakdown-more"
          onClick={() => {
            setShowAll(true);
          }}
        >
          Show all {briefs.length} sections
        </button>
      )}
      {reading && <Skeleton count={briefs.length > 0 ? 1 : 3} />}
      {state.kind === 'cached' && state.omitted > 0 && (
        <p className="muted breakdown-note">
          {state.briefs.length}{' '}
          {state.briefs.length === 1 ? 'part is' : 'parts are'} shown;{' '}
          {state.omitted} more {state.omitted === 1 ? 'is' : 'are'} not
          included. Ask a question below about anything else.
        </p>
      )}
      {state.kind === 'cooling' && (
        <p className="muted breakdown-note">
          {briefs.length > 0
            ? "Couldn't finish reading the rest of the sections just now."
            : "Couldn't read the sections just now."}{' '}
          Trying again in about a minute…
        </p>
      )}
      {(state.kind === 'timeout' || state.kind === 'error') && (
        <p role="alert" className="muted breakdown-note">
          {state.kind === 'timeout'
            ? 'Reading the sections is taking longer than expected.'
            : briefs.length > 0
              ? 'Reading the rest of the sections did not finish.'
              : 'The section-by-section view could not be loaded right now.'}{' '}
          <button type="button" className="link-btn" onClick={retry}>
            Try again
          </button>
        </p>
      )}
    </section>
  );
}
