import { useState } from 'react';
import type { DocSummary } from '../core/model/index.js';

export function Sidebar({
  docs,
  selectedId,
  onSelect,
  onAdd,
  onRemove,
}: {
  docs: DocSummary[];
  selectedId: string | null;
  onSelect: (docId: string) => void;
  onAdd: () => void;
  onRemove: (docId: string) => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <nav aria-label="Loaded documents" className="sidebar">
      <h2>Your documents</h2>
      <button type="button" className="btn" onClick={onAdd}>
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
                  onSelect(d.docId);
                }}
              >
                <span>{d.label}</span>
                {d.billNumber && <span className="muted"> {d.billNumber}</span>}
              </button>
              {confirming === d.docId ? (
                <div
                  role="group"
                  aria-label={`Confirm removing ${d.label}`}
                  className="confirm"
                >
                  <span>Remove this document?</span>
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
                  aria-label={`Remove ${d.label}`}
                  onClick={() => {
                    setConfirming(d.docId);
                  }}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
