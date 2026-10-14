// Local web UI shell: header, sidebar, main screen (ingest or document) and footer.
import { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../core/brand.js';
import type {
  ClientConfig,
  DocSummary,
  IngestStats,
} from '../core/model/index.js';
import { selectApi, type ApiClient } from './api.js';
import { BILL_TITLE_ID } from './document/MetadataHeader.js';
import { DocumentView } from './DocumentView.js';
import { errorMessage } from './errors.js';
import { Ingest } from './Ingest.js';
import { Sidebar } from './Sidebar.js';

export function App({ api: provided }: { api?: ApiClient }) {
  const api = useMemo(
    () =>
      provided ??
      selectApi(
        window.location.search,
        (import.meta.env as Record<string, string | undefined>).VITE_MOCK_API,
      ),
    [provided],
  );
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Where the bill view puts its title and byline: inside the masthead band.
  const [mastheadSlot, setMastheadSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    let live = true;
    Promise.all([api.getConfig(), api.listDocs()])
      .then(([c, list]) => {
        if (!live) return;
        setConfig(c);
        setDocs(list);
        setSelected(list[0]?.docId ?? null);
      })
      .catch((e: unknown) => {
        if (live) setProblem(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api]);

  const productName = config?.productName ?? BRAND.displayName;
  useEffect(() => {
    document.title = productName;
  }, [productName]);

  function onIngested(doc: DocSummary, stats: IngestStats) {
    setDocs((prev) => [doc, ...prev.filter((d) => d.docId !== doc.docId)]);
    setSelected(doc.docId);
    setNotice(
      stats.reused
        ? 'This document was already loaded, so nothing new was processed.'
        : null,
    );
  }

  async function remove(docId: string) {
    try {
      await api.removeDoc(docId);
    } catch (e) {
      setProblem(errorMessage(e));
      return;
    }
    setProblem(null);
    const rest = docs.filter((d) => d.docId !== docId);
    setDocs(rest);
    if (selected === docId) setSelected(rest[0]?.docId ?? null);
  }

  return (
    <div className="app" data-screen={selected === null ? 'home' : 'bill'}>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="masthead">
        <div className="brand">
          <svg
            aria-hidden="true"
            width="32"
            height="32"
            viewBox="0 0 32 32"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <rect x="3" y="3" width="26" height="26" rx="8" />
            <path d="M10 12h12M10 17h12M10 22h7" />
          </svg>
          <h1>{productName}</h1>
        </div>
        {selected === null && (
          <div className="hero">
            <p className="hero-kicker">Federal, state and local legislation</p>
            <p className="hero-title">Understand any bill, line by line.</p>
            <p className="hero-sub">
              Paste a link. Get a plain-language answer, and see the exact
              section and line behind every point.
            </p>
          </div>
        )}
        <div className="masthead-doc" ref={setMastheadSlot} />
      </header>
      <div className="layout">
        {config && (
          <Sidebar
            docs={docs}
            selectedId={selected}
            onSelect={(id) => {
              setSelected(id);
              setNotice(null);
            }}
            onAdd={() => {
              setSelected(null);
              setNotice(null);
            }}
            onRemove={(id) => void remove(id)}
          />
        )}
        <main
          id="main"
          tabIndex={-1}
          aria-labelledby={selected !== null ? BILL_TITLE_ID : undefined}
        >
          {problem && (
            <p role="alert" className="error">
              {problem}
            </p>
          )}
          {loading && <p role="status">Loading...</p>}
          {config && selected === null && (
            <Ingest api={api} onIngested={onIngested} />
          )}
          {config && selected !== null && (
            <DocumentView
              key={selected}
              api={api}
              config={config}
              docId={selected}
              notice={notice}
              mastheadSlot={mastheadSlot}
            />
          )}
        </main>
      </div>
      <footer className="site-footer">
        Not legal advice. Answers are generated only from the text of this
        document.
      </footer>
    </div>
  );
}
