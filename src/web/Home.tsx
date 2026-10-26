// The homepage: add a bill, pick up where you left off, or try an example.
import { useId, useState } from 'react';
import type {
  ClientConfig,
  DocSummary,
  IngestStats,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { formatRelativeDate } from './format-date.js';
import { Ingest } from './Ingest.js';
import { docPath, Link } from './nav.js';

export function Home({
  api,
  docs,
  examples,
  onIngested,
}: {
  api: ApiClient;
  docs: DocSummary[];
  examples: ClientConfig['examples'];
  onIngested: (doc: DocSummary, stats: IngestStats) => void;
}) {
  const docsTitleId = useId();
  // Each click remounts the form (new key), so choosing the same example twice runs it twice.
  const [example, setExample] = useState<{ url: string; n: number } | null>(
    null,
  );
  const [now] = useState(() => Date.now());
  return (
    <>
      <Ingest
        key={example?.n ?? 0}
        api={api}
        onIngested={onIngested}
        {...(example ? { autoStart: example.url } : {})}
      />
      {examples && examples.length > 0 && (
        <p className="examples">
          <span>Try an example: </span>
          {examples.map((ex) => (
            <button
              key={ex.url}
              type="button"
              className="link-btn"
              onClick={() => {
                setExample((prev) => ({ url: ex.url, n: (prev?.n ?? 0) + 1 }));
              }}
            >
              {ex.label}
            </button>
          ))}
        </p>
      )}
      <section aria-labelledby={docsTitleId} className="card home-docs">
        <h2 id={docsTitleId}>Your documents</h2>
        {docs.length === 0 ? (
          <p className="muted">
            Nothing here yet. Paste a bill&apos;s web address above, or try an
            example.
          </p>
        ) : (
          <ul>
            {docs.map((d) => (
              <li key={d.docId}>
                <Link to={docPath(d.docId)} className="home-doc">
                  <span className="home-doc-name">{d.label}</span>
                  {d.billNumber && (
                    <span className="muted"> {d.billNumber}</span>
                  )}
                  <span className="muted home-doc-date">
                    {' '}
                    {formatRelativeDate(d.lastUsedAt, now)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
