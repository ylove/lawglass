import { useEffect, useId, useRef, useState } from 'react';
import type { Scenario } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { errorMessage } from '../errors.js';
import { ScenarioStrip } from './ScenarioStrip.js';

/** Most strips kept on the page; the oldest is dropped so the page does not grow without end. */
export const MAX_SCENARIOS = 5;
/** Mirrors the server's limit on `ScenarioRequest.subject`. */
export const MAX_SUBJECT_LENGTH = 80;

interface Result {
  id: number;
  subject: string;
  /** Null when the bill's text gave nothing to ground an example on. */
  scenario: Scenario | null;
  /** Focus the heading on arrival; false when the reader has moved on since asking. */
  focus: boolean;
}

/** Where a request came from, so an error is tied to the control the reader actually used. */
type Source = 'form' | 'persona';

/** Gap between clearing and re-filling the live region so a repeated message is re-read. */
const ANNOUNCE_GAP_MS = 60;

/** Collapses whitespace so "a  renter" and "a renter" count as the same subject. */
const normalize = (s: string) => s.trim().replace(/\s+/g, ' ');

/**
 * "How does this affect...?": the reader picks a suggested person or types their own, and each
 * answer stacks as its own example strip. This is deliberately separate from the single answer
 * turn in DocumentView, so asking a question never wipes out an example (or the other way round).
 */
export function ScenarioPicker({
  api,
  docId,
  personas,
  onOpenSection,
}: {
  api: ApiClient;
  docId: string;
  personas: readonly string[];
  onOpenSection: (sectionId: string, trigger: HTMLElement) => void;
}) {
  const [custom, setCustom] = useState('');
  const [pending, setPending] = useState<string[]>([]);
  const [results, setResults] = useState<Result[]>([]);
  const [error, setError] = useState<{
    message: string;
    source: Source;
  } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const nextId = useRef(0);
  // Subjects in flight, read synchronously so a double click cannot slip a second request in
  // before React has re-rendered.
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const controllers = useRef(new Set<AbortController>());
  const announceTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  // One wrapper element per stacked result, so a repeat request can point at the existing one.
  const resultEls = useRef(new Map<number, HTMLElement>());
  const inputId = useId();
  const errorId = useId();
  const headingId = useId();

  useEffect(() => {
    mounted.current = true;
    const flying = inFlight.current;
    const live = controllers.current;
    return () => {
      mounted.current = false;
      flying.clear();
      // The reader left (or switched document): stop paying for model calls nobody will see.
      for (const c of live) c.abort();
      live.clear();
      clearTimeout(announceTimer.current);
    };
  }, []);

  /** Clears the region first: some screen readers skip text identical to what was just read. */
  function announce(text: string) {
    clearTimeout(announceTimer.current);
    setAnnouncement('');
    announceTimer.current = setTimeout(() => {
      setAnnouncement(text);
    }, ANNOUNCE_GAP_MS);
  }

  async function request(raw: string, source: Source) {
    const subject = normalize(raw).slice(0, MAX_SUBJECT_LENGTH);
    const key = subject.toLowerCase();
    if (subject === '' || inFlight.current.has(key)) return;
    // Already answered: point at that result rather than spend another model call.
    const existing = results.find((r) => r.subject.toLowerCase() === key);
    const existingEl = existing && resultEls.current.get(existing.id);
    if (existingEl) {
      // Not every environment (jsdom, older browsers) implements scrolling.
      if (typeof existingEl.scrollIntoView === 'function')
        existingEl.scrollIntoView({ block: 'nearest' });
      (existingEl.querySelector('h3') ?? existingEl).focus();
      announce(`An example for ${existing.subject} is already shown below.`);
      return;
    }
    const trigger = document.activeElement;
    const controller = new AbortController();
    controllers.current.add(controller);
    inFlight.current.add(key);
    setPending((p) => [...p, subject]);
    setError(null);
    announce(`Making an example for ${subject}…`);
    try {
      const r = await api.getScenario(docId, { subject }, controller.signal);
      if (!mounted.current) return;
      // Only take focus if the reader is still where they asked from (or nowhere in particular).
      const active = document.activeElement;
      const focus =
        active === trigger || active === null || active === document.body;
      const id = ++nextId.current;
      if (r.status === 'ok' && r.scenario) {
        const scenario = r.scenario;
        setResults((all) =>
          [...all, { id, subject, scenario, focus }].slice(-MAX_SCENARIOS),
        );
        announce(`An example for ${subject} was added below.`);
      } else {
        // `none` (and a surprise `disabled`) both mean there is nothing to show for this subject.
        setResults((all) =>
          [...all, { id, subject, scenario: null, focus }].slice(
            -MAX_SCENARIOS,
          ),
        );
        announce(`No example was added for ${subject}.`);
      }
    } catch (e) {
      if (!mounted.current || controller.signal.aborted) return;
      setError({ message: errorMessage(e), source });
      clearTimeout(announceTimer.current);
      setAnnouncement('');
    } finally {
      controllers.current.delete(controller);
      inFlight.current.delete(key);
      if (mounted.current) setPending((p) => p.filter((s) => s !== subject));
    }
  }

  const isPending = (subject: string) =>
    pending.some((p) => p.toLowerCase() === normalize(subject).toLowerCase());
  const formError = error?.source === 'form' ? error : null;
  const customTrimmed = normalize(custom);

  return (
    <>
      <section aria-labelledby={headingId} className="card scenario-picker">
        <h3 id={headingId}>How does this affect…?</h3>
        {personas.length > 0 && (
          <ul className="persona-list">
            {personas.map((persona) => (
              <li key={persona}>
                <button
                  type="button"
                  className="chip"
                  aria-disabled={isPending(persona)}
                  onClick={() => {
                    void request(persona, 'persona');
                  }}
                >
                  {persona}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error?.source === 'persona' && (
          <p role="alert" className="error persona-error">
            {error.message}
          </p>
        )}
        <form
          className="persona-form"
          onSubmit={(e) => {
            e.preventDefault();
            void request(custom, 'form');
          }}
        >
          <label htmlFor={inputId}>Someone else…</label>
          <div className="row">
            <input
              id={inputId}
              type="text"
              maxLength={MAX_SUBJECT_LENGTH}
              value={custom}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? errorId : undefined}
              onChange={(e) => {
                setCustom(e.target.value);
                setError(null);
              }}
            />
            <button
              type="submit"
              className="btn primary"
              aria-disabled={customTrimmed === '' || isPending(custom)}
            >
              Show an example
            </button>
          </div>
          {formError && (
            <p id={errorId} role="alert" className="error persona-error">
              {formError.message}
            </p>
          )}
        </form>
        {pending.map((subject) => (
          <p key={subject} className="muted persona-loading">
            Making an example for {subject}…
          </p>
        ))}
        {/* Always mounted so changes are announced; the page's one role=status is elsewhere. */}
        <p aria-live="polite" className="sr-only">
          {announcement}
        </p>
      </section>
      {results.map((r) => (
        <div
          key={r.id}
          tabIndex={r.scenario ? undefined : -1}
          ref={(el) => {
            if (el) resultEls.current.set(r.id, el);
            else resultEls.current.delete(r.id);
          }}
        >
          {r.scenario ? (
            <ScenarioStrip
              scenario={r.scenario}
              heading={`What it could mean for ${r.subject}`}
              focusHeading={r.focus}
              onOpenSection={onOpenSection}
            />
          ) : (
            <p className="card muted persona-none">
              Couldn't ground an example for {r.subject} in this bill's text.
            </p>
          )}
        </div>
      ))}
    </>
  );
}
