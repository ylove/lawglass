// The homepage: add a bill, pick up where you left off, or try an example.
import { useContext, useId, useState } from 'react';
import type {
  ClientConfig,
  DocSummary,
  IngestStats,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { formatRelativeDate } from './format-date.js';
import { Ingest } from './Ingest.js';
import { docPath, HOME_PATH, Link, NavContext } from './nav.js';

export function Home({
  api,
  docs,
  examples,
  openUrl = null,
  onIngested,
}: {
  api: ApiClient;
  docs: DocSummary[];
  examples: ClientConfig['examples'];
  /** A bill address from a `/?url=` link. It is only offered; reading it needs a click. */
  openUrl?: string | null;
  onIngested: (doc: DocSummary, stats: IngestStats) => void;
}) {
  const docsTitleId = useId();
  const openId = useId();
  // Each click remounts the form (new key), so choosing the same example twice runs it twice.
  const [example, setExample] = useState<{ url: string; n: number } | null>(
    null,
  );
  const navigate = useContext(NavContext);
  const [now] = useState(() => Date.now());
  return (
    <>
      <Ingest
        key={example?.n ?? 0}
        api={api}
        onIngested={onIngested}
        {...(example
          ? { autoStart: example.url }
          : openUrl
            ? { prefill: openUrl }
            : {})}
      />
      {openUrl && !example && (
        <section aria-labelledby={openId} className="card open-link">
          <h2 id={openId}>Read this bill?</h2>
          <p>A link asked to open this address:</p>
          <p className="open-link-url">
            <code>{openUrl}</code>
          </p>
          <p className="muted">
            Reading a bill uses the AI provider you set up, which can cost
            money. Nothing starts until you confirm.
          </p>
          <div className="row">
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setExample((prev) => ({ url: openUrl, n: (prev?.n ?? 0) + 1 }));
              }}
            >
              Read this bill
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                navigate(HOME_PATH);
              }}
            >
              Not now
            </button>
          </div>
        </section>
      )}
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
