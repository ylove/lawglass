// Ingest screen: one URL in, streamed progress out. If the page only links to the bill
// (a "wrapper page"), the reader picks a file and we submit that address instead.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  CandidateLink,
  DocSummary,
  IngestStage,
  IngestStats,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { MOCK_HINT } from './mock-api.js';
import { errorMessage } from './errors.js';

const STAGES: { id: IngestStage; label: string }[] = [
  { id: 'fetching', label: 'Downloading the document' },
  { id: 'parsing', label: 'Reading its structure' },
  { id: 'enriching', label: 'Finding definitions and references' },
  { id: 'chunking', label: 'Splitting it into searchable parts' },
  { id: 'embedding', label: 'Preparing it for search' },
  { id: 'done', label: 'Ready' },
];

const FORMAT_LABEL: Record<CandidateLink['format'], string> = {
  pdf: 'PDF',
  xml: 'XML',
  html: 'Web page',
  text: 'Text',
  unknown: 'Unknown type',
};

/** Returns a plain-language problem, or null when the address is acceptable. */
export function validateUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return 'Enter the web address of a bill.';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'That does not look like a web address. It should start with https://';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return 'Only web addresses starting with http:// or https:// can be used.';
  }
  return null;
}

interface Progress {
  stage: IngestStage;
  done?: number;
  total?: number;
  detail?: string;
}

export function Ingest({
  api,
  onIngested,
}: {
  api: ApiClient;
  onIngested: (doc: DocSummary, stats: IngestStats) => void;
}) {
  const inputId = useId();
  const errorId = useId();
  const [url, setUrl] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [candidates, setCandidates] = useState<CandidateLink[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      abort.current?.abort();
    },
    [],
  );

  async function submit(address: string) {
    const problem = validateUrl(address);
    setFieldError(problem);
    if (problem) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setFailure(null);
    setCandidates(null);
    setProgress({ stage: 'fetching' });
    let finished = false;
    try {
      for await (const event of api.ingest(
        { url: address.trim() },
        controller.signal,
      )) {
        if (controller.signal.aborted) return;
        if (event.type === 'progress') {
          setProgress({
            stage: event.stage,
            ...(event.done !== undefined ? { done: event.done } : {}),
            ...(event.total !== undefined ? { total: event.total } : {}),
            ...(event.detail !== undefined ? { detail: event.detail } : {}),
          });
        } else if (event.type === 'candidates') {
          setCandidates(event.links);
          setProgress(null);
          finished = true;
        } else if (event.type === 'error') {
          setFailure(event.error.message);
          setProgress(null);
          finished = true;
        } else {
          finished = true;
          onIngested(event.doc, event.stats);
          return;
        }
      }
      if (!finished)
        setFailure(
          'The connection ended before the document was ready. Please try again.',
        );
    } catch (e) {
      if (!controller.signal.aborted) setFailure(errorMessage(e));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
    }
  }

  function pick(link: CandidateLink) {
    setUrl(link.url);
    void submit(link.url);
  }

  const currentIndex = progress
    ? STAGES.findIndex((s) => s.id === progress.stage)
    : -1;

  return (
    <section aria-labelledby="ingest-title" className="card">
      <h2 id="ingest-title">Add a bill</h2>
      <p>
        Paste the web address of a bill or ordinance. We will read it and then
        you can ask questions about it.
      </p>
      {api.mock && <p className="note">{MOCK_HINT}</p>}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit(url);
        }}
      >
        <label htmlFor={inputId}>Web address of the bill</label>
        <div className="row">
          <input
            id={inputId}
            type="url"
            inputMode="url"
            autoComplete="off"
            placeholder="https://"
            value={url}
            aria-invalid={fieldError !== null}
            aria-describedby={fieldError ? errorId : undefined}
            onChange={(e) => {
              setUrl(e.target.value);
            }}
          />
          <button type="submit" className="btn primary" disabled={running}>
            {running ? 'Reading...' : 'Read this bill'}
          </button>
        </div>
        {fieldError && (
          <p id={errorId} role="alert" className="error">
            {fieldError}
          </p>
        )}
      </form>

      {progress && (
        <div aria-live="polite" className="progress">
          <ol>
            {STAGES.map((s, i) => {
              const state =
                i < currentIndex || progress.stage === 'done'
                  ? 'done'
                  : i === currentIndex
                    ? 'current'
                    : 'todo';
              return (
                <li
                  key={s.id}
                  data-state={state}
                  aria-current={state === 'current' ? 'step' : undefined}
                >
                  {s.label}
                  {state === 'done' && (
                    <span className="sr-only"> (finished)</span>
                  )}
                  {state === 'current' && (
                    <span className="sr-only"> (in progress)</span>
                  )}
                  {state === 'current' &&
                    progress.total !== undefined &&
                    progress.done !== undefined && (
                      <span className="count">
                        {' '}
                        {progress.done} of {progress.total}
                      </span>
                    )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {failure && (
        <p role="alert" className="error">
          {failure}
        </p>
      )}

      {candidates && (
        <div className="candidates">
          <h3>Choose the file to read</h3>
          <p>This page links to the bill instead of containing it.</p>
          {candidates.length === 0 && (
            <p>No bill files were found on that page.</p>
          )}
          <ul>
            {candidates.map((c) => (
              <li key={c.url}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    pick(c);
                  }}
                >
                  {c.text || c.url}{' '}
                  <span className="muted">({FORMAT_LABEL[c.format]})</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
