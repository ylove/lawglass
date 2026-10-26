// Local web UI shell: header, sidebar, main screen (ingest or document) and footer.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BRAND } from '../core/brand.js';
import type {
  ClientConfig,
  DocSummary,
  IngestStats,
} from '../core/model/index.js';
import { selectApi, type ApiClient } from './api.js';
import { ServerDownCard } from './document/ServerDownCard.js';
import { BILL_TITLE_ID } from './document/MetadataHeader.js';
import { DocumentView } from './DocumentView.js';
import { errorMessage } from './errors.js';
import { Home } from './Home.js';
import { LogoMark } from './LogoMark.js';
import {
  docPath,
  HOME_PATH,
  Link,
  NavContext,
  parseDocPath,
  withSearch,
} from './nav.js';
import { dataNote } from './provider-label.js';
import { Sidebar } from './Sidebar.js';
import { ApiError } from './sse.js';

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
  // The address bar is the source of truth for what is open: `/` is home, `/doc/<id>` a document.
  const [path, setPath] = useState(() => window.location.pathname);
  const selected = parseDocPath(path);
  const [loading, setLoading] = useState(true);
  const [problem, setProblem] = useState<string | null>(null);
  // True when the first requests could not reach the server at all (not a server-side error).
  const [serverDown, setServerDown] = useState(false);
  // A slow (not unreachable) start: offer Retry instead of leaving a bare message.
  const [slowStart, setSlowStart] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  // Where the bill view puts its title and byline: inside the masthead band.
  const [mastheadSlot, setMastheadSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const onPop = () => {
      setPath(window.location.pathname);
      setNotice(null);
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
    };
  }, []);

  const navigate = useCallback((to: string) => {
    const target = withSearch(to);
    if (window.location.pathname + window.location.search !== target)
      window.history.pushState({}, '', target);
    setPath(to);
    setNotice(null);
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([api.getConfig(), api.listDocs()])
      .then(([c, list]) => {
        if (!live) return;
        setConfig(c);
        setDocs(list);
      })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof ApiError && e.code === 'NETWORK') setServerDown(true);
        else {
          setProblem(errorMessage(e));
          setSlowStart(
            e instanceof ApiError &&
              (e.code === 'TIMEOUT' || e.code === 'STREAM_LOST'),
          );
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [api, attempt]);

  const note = config ? dataNote(config.provider) : null;
  const productName = config?.productName ?? BRAND.displayName;
  useEffect(() => {
    document.title = productName;
  }, [productName]);

  function onIngested(doc: DocSummary, stats: IngestStats) {
    setDocs((prev) => [doc, ...prev.filter((d) => d.docId !== doc.docId)]);
    navigate(docPath(doc.docId));
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
    if (selected === docId) navigate(HOME_PATH);
  }

  // Opening a document moves it to the top of the reader's own list (and adds a shared link).
  const refreshList = useCallback(() => {
    if (config?.library !== 'reader') return;
    api
      .listDocs()
      .then(setDocs)
      .catch(() => undefined);
  }, [api, config?.library]);

  return (
    <NavContext.Provider value={navigate}>
      <div className="app" data-screen={selected === null ? 'home' : 'bill'}>
        <a className="skip" href="#main">
          Skip to main content
        </a>
        <header className="masthead">
          <div className="brand">
            <Link
              to={HOME_PATH}
              className="brand-link"
              aria-label={`${productName} home`}
            >
              <LogoMark />
              <h1>{productName}</h1>
            </Link>
          </div>
          {selected === null && (
            <div className="hero">
              <p className="hero-kicker">
                Federal, state and local legislation
              </p>
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
          {config && selected !== null && (
            <Sidebar
              docs={docs}
              selectedId={selected}
              perReader={config.library === 'reader'}
              onSelect={(id) => {
                navigate(docPath(id));
              }}
              onAdd={() => {
                navigate(HOME_PATH);
              }}
              onRemove={(id) => void remove(id)}
            />
          )}
          <main
            id="main"
            tabIndex={-1}
            aria-labelledby={selected !== null ? BILL_TITLE_ID : undefined}
          >
            {serverDown && (
              <ServerDownCard
                onRetry={() => {
                  setLoading(true);
                  setServerDown(false);
                  setProblem(null);
                  setAttempt((n) => n + 1);
                }}
              />
            )}
            {problem && (
              <p role="alert" className="error">
                {problem}
              </p>
            )}
            {problem && slowStart && (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setLoading(true);
                  setSlowStart(false);
                  setProblem(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Retry
              </button>
            )}
            {loading && <p role="status">Loading...</p>}
            {config && selected === null && (
              <Home
                api={api}
                docs={docs}
                examples={config.examples}
                onIngested={onIngested}
              />
            )}
            {config && selected !== null && (
              <DocumentView
                key={selected}
                api={api}
                config={config}
                docId={selected}
                notice={notice}
                mastheadSlot={mastheadSlot}
                onLoaded={refreshList}
              />
            )}
          </main>
        </div>
        <footer className="site-footer">
          <p>
            Not legal advice. Answers are generated only from the text of this
            document.
          </p>
          {note && <p>{note}</p>}
          <p>
            <a href={BRAND.repositoryUrl} rel="noopener noreferrer">
              Source code
            </a>
          </p>
        </footer>
      </div>
    </NavContext.Provider>
  );
}
