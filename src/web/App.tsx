// Local web UI shell: header, sidebar, main screen (ingest or document) and footer.
import { useEffect, useMemo, useState } from 'react';
import { BRAND } from '../core/brand.js';
import type {
  ClientConfig,
  DocSummary,
  IngestStats,
} from '../core/model/index.js';
import { selectApi, type ApiClient } from './api.js';
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
    <div className="app">
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="site-header">
        <h1>{productName}</h1>
        <p className="muted">
          Plain-language answers about a bill, with sources.
        </p>
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
        <main id="main" tabIndex={-1}>
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
