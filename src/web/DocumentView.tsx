// Document screen: metadata, question chips, the streamed answer with citations, and the
// "referenced, not loaded" panel. This file keeps the state and the SSE run; the pieces it
// composes live in ./document/.
import { useEffect, useRef, useState } from 'react';
import type {
  AskRequest,
  ClientConfig,
  DocDetail,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { CitationDrawer } from './CitationDrawer.js';
import { AnswerCard } from './document/AnswerCard.js';
import { AskForm } from './document/AskForm.js';
import { ChipRow } from './document/ChipRow.js';
import { MetadataHeader } from './document/MetadataHeader.js';
import { NoticeBar } from './document/NoticeBar.js';
import { ReferencedCard } from './document/ReferencedCard.js';
import { FactsCard } from './document/FactsCard.js';
import { HistoryCard } from './document/HistoryCard.js';
import { ServerDownCard } from './document/ServerDownCard.js';
import { SummaryPanel } from './document/SummaryPanel.js';
import type { Turn } from './document/types.js';
import { errorMessage } from './errors.js';
import { ApiError } from './sse.js';
import { CUT_OFF } from './sse.js';

export function DocumentView({
  api,
  config,
  docId,
  notice,
  mastheadSlot,
}: {
  api: ApiClient;
  config: ClientConfig;
  docId: string;
  notice?: string | null;
  /** The masthead element that should hold the bill's title; falls back to inline. */
  mastheadSlot?: HTMLElement | null;
}) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [open, setOpen] = useState<{
    sectionId: string;
    trigger: HTMLElement;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const nextTurnId = useRef(0);

  useEffect(() => {
    let live = true;
    api
      .getDoc(docId)
      .then((d) => {
        if (live) setDetail(d);
      })
      .catch((e: unknown) => {
        if (live) setLoadError(e);
      });
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [api, docId, attempt]);

  const busy = turn?.phase === 'searching' || turn?.phase === 'writing';

  async function run(req: AskRequest, label: string) {
    if (busy) return;
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    setTurn({
      id: ++nextTurnId.current,
      label,
      phase: 'searching',
      text: '',
      result: null,
      error: null,
    });
    try {
      for await (const event of api.ask(docId, req, controller.signal)) {
        if (controller.signal.aborted) return;
        if (event.type === 'scenario') {
          // Arrives after `done`, so this loop keeps reading until the stream closes.
          setTurn((t) => (t ? { ...t, scenario: event.scenario } : t));
        } else if (event.type === 'token') {
          setTurn((t) =>
            t ? { ...t, phase: 'writing', text: t.text + event.text } : t,
          );
        } else if (event.type === 'done') {
          setTurn((t) =>
            t
              ? {
                  ...t,
                  phase: 'done',
                  text: event.answer.text,
                  result: event.answer,
                  ...(event.answer.scenario
                    ? { scenario: event.answer.scenario }
                    : {}),
                }
              : t,
          );
        } else if (event.type === 'error') {
          setTurn((t) =>
            t && t.phase !== 'done'
              ? { ...t, phase: 'error', error: event.error.message }
              : t,
          );
          return;
        }
      }
      setTurn((t) =>
        t && (t.phase === 'searching' || t.phase === 'writing')
          ? {
              ...t,
              phase: 'error',
              error: CUT_OFF,
            }
          : t,
      );
    } catch (e) {
      if (!controller.signal.aborted) {
        setTurn((t) =>
          // A failure after the answer is complete only costs the optional example.
          t && t.phase !== 'done'
            ? { ...t, phase: 'error', error: errorMessage(e) }
            : t,
        );
      }
    }
  }

  if (loadError) {
    if (loadError instanceof ApiError && loadError.code === 'NETWORK') {
      return (
        <ServerDownCard
          onRetry={() => {
            setLoadError(null);
            setAttempt((n) => n + 1);
          }}
        />
      );
    }
    return (
      <p role="alert" className="error">
        {errorMessage(loadError)}
      </p>
    );
  }
  if (!detail) return <p role="status">Loading the document...</p>;

  const openSection = (sectionId: string, trigger: HTMLElement) => {
    setOpen({ sectionId, trigger });
  };

  const showFreeform = config.freeformEnabled && !config.publicMode;

  return (
    <div className="doc">
      <NoticeBar notice={notice} />
      <MetadataHeader
        detail={detail}
        slot={mastheadSlot ?? null}
        onOpenSection={openSection}
      />
      <div className="doc-grid">
        <div className="doc-main">
          <SummaryPanel
            api={api}
            docId={docId}
            preview={detail.preview}
            officialSummary={detail.history?.officialSummary}
            publicMode={config.publicMode}
            onOpenSection={openSection}
          />
          <ChipRow
            chips={config.chips}
            busy={busy}
            activeLabel={turn?.label ?? null}
            onPick={(chipId, label) => {
              void run({ chipId }, label);
            }}
          />
          {showFreeform && (
            <AskForm
              busy={busy}
              onAsk={(q) => {
                void run({ question: q }, q);
              }}
            />
          )}
          <AnswerCard
            turn={turn}
            busy={busy}
            hasLineNumbers={detail.hasLineNumbers}
            onOpenSection={openSection}
          />
        </div>
        <aside aria-label="About this bill" className="doc-aside">
          <FactsCard detail={detail} />
          <HistoryCard
            history={detail.history}
            canAskFullStory={config.chips.some((c) => c.id === 'history')}
            busy={busy}
            onFullStory={() => {
              const chip = config.chips.find((c) => c.id === 'history');
              if (chip) void run({ chipId: chip.id }, chip.label);
            }}
          />
          <ReferencedCard externalRefs={detail.externalRefs} />
        </aside>
      </div>
      {open && (
        <CitationDrawer
          key={open.sectionId}
          api={api}
          docId={docId}
          sectionId={open.sectionId}
          hasLineNumbers={detail.hasLineNumbers}
          returnFocusTo={open.trigger}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}
