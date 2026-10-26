import { useId, useState } from 'react';
import type { DocSummary } from '../core/model/index.js';

export function Sidebar({
  docs,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
  perReader = false,
}: {
  docs: DocSummary[];
  selectedId: string | null;
  onSelect: (docId: string) => void;
  onAdd: () => void;
  onRemove: (docId: string) => void;
  /** Hosted servers: removing only takes a document off this reader's list. */
  perReader?: boolean;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  // Only meaningful at narrow widths, where the list collapses behind a disclosure button.
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  return (
    <nav aria-label="Loaded documents" className="sidebar">
      <button
        type="button"
        className="btn sidebar-toggle"
        aria-expanded={expanded}
        aria-controls={panelId}
        onClick={() => {
          setExpanded((v) => !v);
        }}
      >
        {`Your documents (${String(docs.length)})`}
      </button>
      <div
        id={panelId}
        className={expanded ? 'sidebar-panel open' : 'sidebar-panel'}
      >
        <h2>Your documents</h2>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setExpanded(false);
            onAdd();
          }}
        >
          Add a bill
        </button>
        {docs.length === 0 ? (
          <p className="muted">Nothing loaded yet.</p>
        ) : (
          <ul>
            {docs.map((d) => (
              <li key={d.docId}>
                <button
                  type="button"
                  className="doc-link"
                  aria-current={d.docId === selectedId ? 'page' : undefined}
                  onClick={() => {
                    setExpanded(false);
                    onSelect(d.docId);
                  }}
                >
                  <span>{d.label}</span>
                  {d.billNumber && (
                    <span className="muted"> {d.billNumber}</span>
                  )}
                </button>
                {confirming === d.docId ? (
                  <div
                    role="group"
                    aria-label={`Confirm removing ${d.label}`}
                    className="confirm"
                  >
                    <span>
                      {perReader
                        ? 'Remove this from your list? It stays available to others.'
                        : 'Remove this document?'}
                    </span>
                    <button
                      type="button"
                      className="btn danger"
                      onClick={() => {
                        setConfirming(null);
                        onRemove(d.docId);
                      }}
                    >
                      Yes, remove
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        setConfirming(null);
                      }}
                    >
                      Keep it
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="link-btn"
                    aria-label={
                      perReader
                        ? `Remove ${d.label} from my list`
                        : `Remove ${d.label}`
                    }
                    onClick={() => {
                      setConfirming(d.docId);
                    }}
                  >
                    {perReader ? 'Remove from my list' : 'Remove'}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}
