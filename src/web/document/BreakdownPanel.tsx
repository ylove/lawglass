import { useEffect, useRef, useState } from 'react';
import type {
  OutlineItem,
  PictureEntry,
  SectionBrief,
} from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { AnswerText, type OpenCitation } from '../AnswerText.js';
import { ApiError } from '../sse.js';
import {
  filterBriefs,
  groupBriefs,
  GROUPING_THRESHOLD,
  type BriefGroup,
} from './breakdown-groups.js';
import { SERVER_COOL_DOWN_MS } from './cool-down.js';
import { PicturePanels } from './PicturePanels.js';
import { usePictures } from './use-pictures.js';
import { SectionExample } from './SectionExample.js';

/** How often to ask again while the server is still reading the sections. */
export const BREAKDOWN_POLL_MS = 2000;
/**
 * Give up after six minutes without progress; the summary above and the questions below still
 * work. The server may wait up to three minutes for the summary before it starts reading, so the
 * clock restarts whenever a new part arrives.
 */
export const BREAKDOWN_MAX_WAIT_MS = 360_000;
/** How many times a finished long bill is looked at again for a late stop (with backoff). */
export const LATE_REFRESHES = 8;
/** A long bill shows this many cards, then a button for the rest. */
export const INITIAL_VISIBLE_BRIEFS = 6;

/** How far a long bill's breakdown has got, from the server (#382). */
interface Progress {
  done: number;
  total: number;
}

type State =
  | { kind: 'loading'; progress?: Progress | undefined }
  | {
      kind: 'pending';
      briefs: readonly SectionBrief[];
      progress?: Progress | undefined;
    }
  | {
      kind: 'cached';
      briefs: readonly SectionBrief[];
      omitted: number;
      /** Some pictures or examples were not drawn ahead, because this bill's budget ran out. */
      examplesStopped?: boolean;
    }
  /** The server stopped on purpose (a spent budget); what is written is kept. */
  | { kind: 'stopped'; briefs: readonly SectionBrief[]; progress: Progress }
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
  picture,
  onOpenSection,
  examplePollMs,
  exampleMaxWaitMs,
  coolDownMs,
  headingLevel = 4,
}: {
  api: ApiClient;
  docId: string;
  brief: SectionBrief;
  /** The drawing for this brief's text, when the server has one that matches it exactly. */
  picture: PictureEntry | undefined;
  onOpenSection: OpenCitation;
  examplePollMs?: number | undefined;
  exampleMaxWaitMs?: number | undefined;
  coolDownMs: number;
  /** 4 under the panel's own heading, 5 inside a group. */
  headingLevel?: 4 | 5;
}) {
  const Heading = headingLevel === 4 ? 'h4' : 'h5';
  const label = partLabel(brief);
  const titleId = `brief-${brief.sectionId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  return (
    <li>
      <article aria-labelledby={titleId} className="brief-card">
        <Heading id={titleId}>
          <span className="brief-num">{label}</span>
          {brief.num && brief.heading && (
            <span className="brief-heading">{brief.heading}</span>
          )}
        </Heading>
        {picture && (
          <div className="brief-picture">
            <PicturePanels entry={picture} />
          </div>
        )}
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

/**
 * One top-level container of a long bill, collapsible. The button is the group's heading, so a
 * screen-reader user can move between groups by heading and open one with a key press.
 */
function GroupSection({
  group,
  index,
  expanded,
  onToggle,
  renderCard,
}: {
  group: BriefGroup;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  renderCard: (brief: SectionBrief) => React.ReactNode;
}) {
  const bodyId = `brief-group-body-${String(index)}`;
  return (
    <section className="brief-group">
      <h4 className="brief-group-heading">
        <button
          type="button"
          className="brief-group-toggle"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={onToggle}
        >
          <span className="brief-group-label">{group.label}</span>
          <span className="muted brief-group-count">
            {group.briefs.length}{' '}
            {group.briefs.length === 1 ? 'section' : 'sections'}
          </span>
        </button>
      </h4>
      <div id={bodyId} hidden={!expanded}>
        {expanded && (
          <ul className="brief-list">
            {group.briefs.map((brief) => renderCard(brief))}
          </ul>
        )}
      </div>
    </section>
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
  outline,
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
  /** The document outline, to group a long bill by its divisions or titles. */
  outline?: readonly OutlineItem[] | undefined;
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
  const [query, setQuery] = useState('');
  // Groups the reader opened or closed by hand; the first group starts open.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
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
    let lastDone = 0;
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
            autoRetried.current = false;
            setState({
              kind: 'cached',
              briefs: r.briefs,
              omitted: r.omitted ?? 0,
              ...(r.progress?.stoppedReason ? { examplesStopped: true } : {}),
            });
          } else if (r.status === 'disabled' || r.status === 'cached') {
            setState({ kind: 'disabled' });
          } else if (r.progress?.stoppedReason) {
            // Nothing more is coming: say so instead of polling for it.
            setState({
              kind: 'stopped',
              briefs: shown.current,
              progress: r.progress,
            });
          } else if (Date.now() - lastProgress >= maxWaitMs) {
            setState({ kind: 'timeout', briefs: shown.current });
          } else {
            // A reply with fewer parts than are already shown (a retry restarting) must not
            // replace the cards the reader is looking at.
            if (r.progress && r.progress.done > lastDone) {
              lastDone = r.progress.done;
              lastProgress = Date.now();
            }
            setState({
              kind: 'pending',
              briefs: shown.current,
              progress: r.progress,
            });
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

  // A long bill's pictures and examples are still being drawn in the background after the
  // briefs are whole, and a budget can run out then. Look again a few times, backing off, so a
  // late stop is shown; the cap keeps a finished bill from being asked about forever.
  const settledLong =
    state.kind === 'cached' &&
    state.briefs.length > GROUPING_THRESHOLD &&
    !state.examplesStopped;
  useEffect(() => {
    if (!enabled || !settledLong) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const later = () => {
      if (attempt >= LATE_REFRESHES) return;
      const delay = Math.min(pollMs * 2 ** attempt, pollMs * 30);
      attempt++;
      timer = setTimeout(() => {
        api
          .getBreakdown(docId)
          .then((r) => {
            if (!live) return;
            if (r.progress?.stoppedReason) {
              setState((now) =>
                now.kind === 'cached' ? { ...now, examplesStopped: true } : now,
              );
            } else later();
          })
          .catch(() => {
            // A failed look is not an error for a finished breakdown; try the next one.
            if (live) later();
          });
      }, delay);
    };
    later();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, docId, enabled, settledLong, pollMs]);

  // A short bill's pictures wait for its finished briefs. A long one is drawn a group of briefs
  // at a time as they arrive; a server that does not do that answers `none` until the end, and
  // the look is repeated once the breakdown is complete.
  const pictures = usePictures(
    (signal) => api.getBreakdownPictures(docId, signal),
    enabled &&
      (state.kind === 'cached' ||
        // Only a long bill (more parts than the default cap) is drawn as it arrives.
        ((state.kind === 'pending' || state.kind === 'stopped') &&
          state.briefs.length > 0 &&
          (state.progress?.total ?? 0) > GROUPING_THRESHOLD)),
    docId,
    pollMs,
    maxWaitMs,
    state.kind === 'cached' ? 1 : 0,
  );

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
  const reading = state.kind === 'loading' || state.kind === 'pending';
  const waiting = reading || state.kind === 'cooling';
  const progress =
    state.kind === 'pending' ||
    state.kind === 'stopped' ||
    state.kind === 'loading'
      ? state.progress
      : undefined;
  const total = Math.max(progress?.total ?? 0, briefs.length);
  const large = total > GROUPING_THRESHOLD;
  const matching = large ? filterBriefs(briefs, query) : briefs;
  const filtering = large && query.trim() !== '';
  const groups = large ? groupBriefs(matching, outline) : undefined;
  const visible =
    showAll || filtering || groups
      ? matching
      : matching.slice(0, INITIAL_VISIBLE_BRIEFS);

  const card = (brief: SectionBrief, headingLevel: 4 | 5 = 4) => (
    <BriefCard
      key={brief.sectionId}
      api={api}
      docId={docId}
      brief={brief}
      picture={pictures.find(
        (p) => p.sectionId === brief.sectionId && p.text === brief.text,
      )}
      onOpenSection={onOpenSection}
      examplePollMs={examplePollMs}
      exampleMaxWaitMs={exampleMaxWaitMs}
      coolDownMs={coolDownMs}
      headingLevel={headingLevel}
    />
  );

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
          {progress && progress.total > 0
            ? `${progress.done.toLocaleString('en-US')} of ${progress.total.toLocaleString('en-US')} sections ready`
            : briefs.length > 0
              ? 'Reading the rest of the sections…'
              : 'Reading each section…'}
        </p>
      )}
      {state.kind === 'stopped' && (
        <p className="muted breakdown-note">
          {state.progress.done.toLocaleString('en-US')} of{' '}
          {state.progress.total.toLocaleString('en-US')} sections are ready.
          Reading stopped because the limit set for this bill was reached. Ask a
          question below about anything else.
        </p>
      )}
      {large && briefs.length > 0 && (
        <div className="breakdown-filter">
          <label htmlFor="breakdown-filter-input" className="muted">
            Find in these sections
          </label>
          <input
            id="breakdown-filter-input"
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
          />
          {filtering && (
            <p className="muted breakdown-note">
              {matching.length.toLocaleString('en-US')} of{' '}
              {briefs.length.toLocaleString('en-US')} sections match.
            </p>
          )}
        </div>
      )}
      {groups
        ? groups.map((group, index) => (
            <GroupSection
              key={group.id}
              group={group}
              index={index}
              // A search opens every group that has a match; otherwise the reader's choice
              // stands, with the first group open to begin with.
              expanded={filtering || (toggled[group.id] ?? index === 0)}
              onToggle={() => {
                setToggled((t) => ({
                  ...t,
                  [group.id]: !(t[group.id] ?? index === 0),
                }));
              }}
              renderCard={(brief) => card(brief, 5)}
            />
          ))
        : visible.length > 0 && (
            <ul className="brief-list">
              {visible.map((brief) => card(brief))}
            </ul>
          )}
      {filtering && matching.length === 0 && (
        <p className="muted breakdown-note">No sections match.</p>
      )}
      {!groups && !filtering && briefs.length > visible.length && (
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
      {state.kind === 'cached' && state.examplesStopped && (
        <p className="muted breakdown-note">
          Some pictures or examples were not drawn ahead because the limit set
          for this bill was reached. You can still open any example.
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
