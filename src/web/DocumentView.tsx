// Document screen: metadata, question chips, the streamed answer with citations, and the
// "referenced, not loaded" panel.
import { useEffect, useId, useRef, useState } from 'react';
import type {
  AnswerResult,
  AnswerWarning,
  AskRequest,
  ClientConfig,
  DocDetail,
} from '../core/model/index.js';
import type { ApiClient } from './api.js';
import { AnswerText, stripMarkers } from './AnswerText.js';
import { CitationDrawer, describeLocation } from './CitationDrawer.js';
import { errorMessage } from './errors.js';
import { CUT_OFF } from './sse.js';

const WARNING_TEXT: Record<AnswerWarning, string> = {
  NO_VALID_CITATIONS:
    'This answer could not be tied to a specific section, so treat it with extra care.',
  INVALID_CITATIONS_REMOVED:
    'Some references in this answer did not match the document and were removed.',
  NO_RELEVANT_EXCERPTS:
    'No passages in the document matched this question closely.',
  TRUNCATED: 'This answer was cut short, so it may be incomplete.',
};

const STATUS_TEXT: Record<Phase, string> = {
  searching: 'Searching the document...',
  writing: 'Writing the answer...',
  done: 'Answer ready',
  error: '',
};

const KIND_LABEL = {
  us_code: 'Federal law',
  public_law: 'Public law',
  state_code: 'State law',
  cfr: 'Federal regulation',
  other: 'Other law',
} as const;

type Phase = 'searching' | 'writing' | 'done' | 'error';
interface Turn {
  label: string;
  phase: Phase;
  text: string;
  result: AnswerResult | null;
  error: string | null;
}

function Metadata({ detail }: { detail: DocDetail }) {
  const m = detail.metadata;
  const rows: [string, string][] = [];
  if (m.billNumber) rows.push(['Number', m.billNumber]);
  if (m.jurisdiction) rows.push(['Jurisdiction', m.jurisdiction]);
  if (m.session) rows.push(['Session', m.session]);
  if (m.version) rows.push(['Version', m.version]);
  if (m.sponsors && m.sponsors.length > 0)
    rows.push(['Sponsors', m.sponsors.join(', ')]);
  return (
    <div className="doc-header">
      <h2>{m.title ?? detail.doc.label}</h2>
      {rows.length > 0 && (
        <dl>
          {rows.map(([k, v]) => (
            <div key={k}>
              <dt>{k}</dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      )}
      {m.source === 'extracted' && (
        <p className="note">
          These details were picked out of the text automatically and may be
          incomplete.
        </p>
      )}
      {detail.warnings.map((w) => (
        <p key={w} className="note">
          {w}
        </p>
      ))}
    </div>
  );
}

export function DocumentView({
  api,
  config,
  docId,
  notice,
}: {
  api: ApiClient;
  config: ClientConfig;
  docId: string;
  notice?: string | null;
}) {
  const [detail, setDetail] = useState<DocDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [turn, setTurn] = useState<Turn | null>(null);
  const [question, setQuestion] = useState('');
  const [open, setOpen] = useState<{
    sectionId: string;
    trigger: HTMLElement;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const questionId = useId();

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
    setTurn({ label, phase: 'searching', text: '', result: null, error: null });
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
  const citations = turn?.result?.citations.filter((c) => c.valid) ?? [];

  return (
    <div className="doc">
      {notice && (
        <p className="note" role="status">
          {notice}
        </p>
      )}
      <Metadata detail={detail} />

      <section aria-labelledby="chips-title">
        <h3 id="chips-title">What would you like to know?</h3>
        <div role="group" aria-labelledby="chips-title" className="chips">
          {config.chips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className="chip"
              aria-disabled={busy}
              onClick={() => {
                // aria-disabled (not disabled) keeps keyboard focus on the chip.
                if (busy) return;
                void run({ chipId: chip.id }, chip.label);
              }}
            >
              {chip.label}
            </button>
          ))}
        </div>
      </section>

      {showFreeform && (
        <form
          className="ask"
          onSubmit={(e) => {
            e.preventDefault();
            const q = question.trim();
            if (q === '' || busy) return;
            void run({ question: q }, q);
          }}
        >
          <label htmlFor={questionId}>Or ask your own question</label>
          <div className="row">
            <input
              id={questionId}
              type="text"
              maxLength={500}
              value={question}
              onChange={(e) => {
                setQuestion(e.target.value);
              }}
            />
            <button
              type="submit"
              className="btn primary"
              aria-disabled={busy || question.trim() === ''}
            >
              Ask
            </button>
          </div>
        </form>
      )}

      <section aria-labelledby="answer-title" className="answer card">
        <h3 id="answer-title">Answer</h3>
        {!turn && (
          <p className="muted">
            Choose a question above to see an answer here.
          </p>
        )}
        {turn && (
          <>
            <p className="asked">
              <span className="sr-only">Question: </span>
              {turn.label}
            </p>
            <p role="status" className="sr-only">
              {STATUS_TEXT[turn.phase]}
            </p>
            <div aria-busy={busy} className="answer-body">
              {turn.phase === 'searching' && (
                <p className="muted">Searching the document...</p>
              )}
              {turn.phase === 'writing' && (
                <AnswerText
                  text={stripMarkers(turn.text)}
                  citations={[]}
                  onOpenCitation={() => undefined}
                />
              )}
              {turn.phase === 'done' && turn.result && (
                <AnswerText
                  text={turn.result.text}
                  citations={turn.result.citations}
                  onOpenCitation={(sectionId, trigger) => {
                    setOpen({ sectionId, trigger });
                  }}
                />
              )}
            </div>
            {turn.error && (
              <p role="alert" className="error">
                {turn.error}
              </p>
            )}
            {turn.result?.warnings.map((w) => (
              <p key={w} className="note">
                {WARNING_TEXT[w]}
              </p>
            ))}
            {turn.phase === 'done' && citations.length > 0 && (
              <div className="sources">
                <h4>Sources</h4>
                <ol>
                  {citations.map((c) => (
                    <li key={c.sectionId}>
                      <button
                        type="button"
                        className="link-btn"
                        onClick={(e) => {
                          setOpen({
                            sectionId: c.sectionId,
                            trigger: e.currentTarget,
                          });
                        }}
                      >
                        {c.breadcrumb ?? c.sectionId}
                      </button>
                      {c.location && (
                        <span className="muted">
                          {' '}
                          -{' '}
                          {describeLocation(c.location, detail.hasLineNumbers)}
                        </span>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </>
        )}
      </section>

      {detail.externalRefs.length > 0 && (
        <section aria-labelledby="refs-title" className="card">
          <h3 id="refs-title">Referenced, not loaded</h3>
          <p className="muted">
            This document mentions other laws. They are not loaded here, so
            answers do not draw on them.
          </p>
          <ul>
            {detail.externalRefs.map((r) => (
              <li key={r.citation}>
                <strong>{r.citation}</strong>{' '}
                <span className="muted">({KIND_LABEL[r.kind]})</span>
                <br />
                <span>{r.text}</span>
                <span className="muted">
                  {' '}
                  - mentioned in {r.sectionIds.length}{' '}
                  {r.sectionIds.length === 1 ? 'section' : 'sections'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

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
