import { useEffect, useId, useRef, useState } from 'react';
import type { Scenario } from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { errorMessage } from '../errors.js';
import { ScenarioStrip } from './ScenarioStrip.js';

/** Most strips kept on the page; the oldest is dropped so the page does not grow without end. */
export const MAX_SCENARIOS = 5;
/** Mirrors the server's limit on `ScenarioRequest.subject`. */
export const MAX_SUBJECT_LENGTH = 80;

type Result =
  | { id: number; subject: string; scenario: Scenario }
  | { id: number; subject: string; scenario: null };

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
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const nextId = useRef(0);
  // Subjects in flight, read synchronously so a double click cannot slip a second request in
  // before React has re-rendered.
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  const inputId = useId();
  const errorId = useId();
  const headingId = useId();

  useEffect(() => {
    mounted.current = true;
    const flying = inFlight.current;
    return () => {
      mounted.current = false;
      flying.clear();
    };
  }, []);

  async function request(raw: string) {
    const subject = normalize(raw).slice(0, MAX_SUBJECT_LENGTH);
    const key = subject.toLowerCase();
    if (subject === '' || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setPending((p) => [...p, subject]);
    setError(null);
    setAnnouncement(`Making an example for ${subject}…`);
    try {
      const r = await api.getScenario(docId, { subject });
      if (!mounted.current) return;
      const id = ++nextId.current;
      if (r.status === 'ok' && r.scenario) {
        const scenario = r.scenario;
        setResults((all) =>
          [...all, { id, subject, scenario }].slice(-MAX_SCENARIOS),
        );
        setAnnouncement(`An example for ${subject} was added below.`);
      } else {
        // `none` (and a surprise `disabled`) both mean there is nothing to show for this subject.
        setResults((all) =>
          [...all, { id, subject, scenario: null }].slice(-MAX_SCENARIOS),
        );
        setAnnouncement(`No example was added for ${subject}.`);
      }
    } catch (e) {
      if (!mounted.current) return;
      const message = errorMessage(e);
      setError(message);
      setAnnouncement('');
    } finally {
      inFlight.current.delete(key);
      if (mounted.current) setPending((p) => p.filter((s) => s !== subject));
    }
  }

  const isPending = (subject: string) =>
    pending.some((p) => p.toLowerCase() === normalize(subject).toLowerCase());
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
                    void request(persona);
                  }}
                >
                  {persona}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="persona-form"
          onSubmit={(e) => {
            e.preventDefault();
            void request(custom);
          }}
        >
          <label htmlFor={inputId}>Someone else…</label>
          <div className="row">
            <input
              id={inputId}
              type="text"
              maxLength={MAX_SUBJECT_LENGTH}
              value={custom}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? errorId : undefined}
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
          {error && (
            <p id={errorId} role="alert" className="error persona-error">
              {error}
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
      {results.map((r) =>
        r.scenario ? (
          <ScenarioStrip
            key={r.id}
            scenario={r.scenario}
            heading={`What it could mean for ${r.subject}`}
            focusHeading
            onOpenSection={onOpenSection}
          />
        ) : (
          <p key={r.id} className="card muted persona-none">
            Couldn't ground an example for {r.subject} in this bill's text.
          </p>
        ),
      )}
    </>
  );
}
