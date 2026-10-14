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
import { SummarySlot } from './document/SummarySlot.js';
import type { Turn } from './document/types.js';
import { errorMessage } from './errors.js';
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
  const [loadError, setLoadError] = useState<string | null>(null);
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
        if (live) setLoadError(errorMessage(e));
      });
    return () => {
      live = false;
      abort.current?.abort();
    };
  }, [api, docId]);

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
        if (event.type === 'token') {
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
                }
              : t,
          );
        } else if (event.type === 'error') {
          setTurn((t) =>
            t ? { ...t, phase: 'error', error: event.error.message } : t,
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
          t ? { ...t, phase: 'error', error: errorMessage(e) } : t,
        );
      }
    }
  }

  if (loadError) {
    return (
      <p role="alert" className="error">
        {loadError}
      </p>
    );
  }
  if (!detail) return <p role="status">Loading the document...</p>;

  const showFreeform = config.freeformEnabled && !config.publicMode;

  return (
    <div className="doc">
      <NoticeBar notice={notice} />
      <MetadataHeader detail={detail} slot={mastheadSlot ?? null} />
      <SummarySlot />
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
        onOpenSection={(sectionId, trigger) => {
          setOpen({ sectionId, trigger });
        }}
      />
      <ReferencedCard externalRefs={detail.externalRefs} />
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
