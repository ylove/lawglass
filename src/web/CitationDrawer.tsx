// The source drawer opened by a citation: where the section sits in the document and its exact
// text, with removed and added wording marked in a way that does not depend on color.
import { useEffect, useRef, useState } from 'react';
import type {
  SectionExcerpt,
  SourceLocation,
  Span,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { errorMessage } from './errors.js';
import { linkifyGov } from './linkify.js';

/** "Page 3, lines 5-12", or a plain statement when the file has no printed lines. */
export function describeLocation(
  location: SourceLocation,
  hasLineNumbers: boolean,
): string {
  if (!hasLineNumbers) {
    return 'Section-only citation. This file type has no printed page or line numbers.';
  }
  const { pageStart, pageEnd, lineStart, lineEnd } = location;
  const parts: string[] = [];
  if (pageStart !== undefined) {
    parts.push(
      pageEnd !== undefined && pageEnd !== pageStart
        ? `Pages ${String(pageStart)}-${String(pageEnd)}`
        : `Page ${String(pageStart)}`,
    );
  }
  if (lineStart !== undefined) {
    parts.push(
      lineEnd !== undefined && lineEnd !== lineStart
        ? `lines ${String(lineStart)}-${String(lineEnd)}`
        : `line ${String(lineStart)}`,
    );
  }
  return parts.length > 0
    ? parts.join(', ')
    : 'Page and line not available for this section.';
}

export function ExcerptSpans({ spans }: { spans: readonly Span[] }) {
  return (
    <p className="excerpt-text">
      {spans.map((span, i) => {
        if (span.status === 'deleted') {
          return (
            <del key={i}>
              <span className="sr-only">removed: </span>
              {linkifyGov(span.text, String(i))}
            </del>
          );
        }
        if (span.status === 'inserted') {
          return (
            <ins key={i}>
              <span className="sr-only">added: </span>
              {linkifyGov(span.text, String(i))}
            </ins>
          );
        }
        return <span key={i}>{linkifyGov(span.text, String(i))}</span>;
      })}
    </p>
  );
}

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function CitationDrawer({
  api,
  docId,
  sectionId,
  hasLineNumbers,
  returnFocusTo,
  onClose,
}: {
  api: ApiClient;
  docId: string;
  sectionId: string;
  hasLineNumbers: boolean;
  returnFocusTo: HTMLElement | null;
  onClose: () => void;
}) {
  const [excerpt, setExcerpt] = useState<SectionExcerpt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    api
      .getSection(docId, sectionId)
      .then((e) => {
        if (live) setExcerpt(e);
      })
      .catch((e: unknown) => {
        if (live) setError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [api, docId, sectionId, attempt]);

  // Move focus into the dialog on open; give it back to the citation on close.
  useEffect(() => {
    closeButton.current?.focus();
    return () => {
      if (returnFocusTo?.isConnected) returnFocusTo.focus();
    };
  }, [returnFocusTo]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== 'Tab' || !panel.current) return;
    // Keep Tab inside the dialog while it is open.
    const items = Array.from(
      panel.current.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        ref={panel}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="drawer-title"
        onKeyDown={onKeyDown}
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="drawer-head">
          <h2 id="drawer-title">Source text</h2>
          <button
            ref={closeButton}
            type="button"
            className="btn"
            onClick={onClose}
          >
            Close
          </button>
        </div>
        {error && (
          <>
            <p role="alert" className="error">
              {error}
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </button>
          </>
        )}
        {!excerpt && !error && <p role="status">Loading the section...</p>}
        {excerpt && (
          <>
            <p className="breadcrumb">{excerpt.breadcrumb}</p>
            <p className="location">
              {describeLocation(excerpt.location, hasLineNumbers)}
            </p>
            <p className="legend">
              <del>Struck-through text</del> was removed.{' '}
              <ins>Underlined text</ins> was added.
            </p>
            <div className="excerpt">
              {(excerpt.num ?? excerpt.heading) && (
                <h3>
                  {[excerpt.num, excerpt.heading].filter(Boolean).join(' ')}
                </h3>
              )}
              <ExcerptSpans spans={excerpt.spans} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
