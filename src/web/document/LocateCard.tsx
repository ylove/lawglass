import { useEffect, useRef, useState } from 'react';
import { Plus, Minus, RefreshCw, BookOpen, FileText } from 'lucide-react';
import type {
  DocDetail,
  LocateLabel,
  LocateResponse,
  LocateVersionsResponse,
} from '../../core/model/index.js';
import type { ApiClient } from '../api.js';
import { AnswerText, type OpenCitation } from '../AnswerText.js';
import { describeLocation, ExcerptSpans } from '../CitationDrawer.js';
import { errorMessage } from '../errors.js';
import { buildReceipt, copyReceipt } from './locate-receipt.js';
import { LABEL_TEXT } from './locate-label-text.js';

const ICONS: Record<LocateLabel, typeof Plus> = {
  added: Plus,
  removed: Minus,
  changed: RefreshCw,
  existing: BookOpen,
  'in-bill': FileText,
};
const LABELS = Object.fromEntries(
  (Object.keys(ICONS) as LocateLabel[]).map((k) => [
    k,
    { text: LABEL_TEXT[k], icon: ICONS[k] },
  ]),
) as Record<LocateLabel, { text: string; icon: typeof Plus }>;

export function LocateCard({
  api,
  detail,
  onOpenSection,
}: {
  api: ApiClient;
  detail: DocDetail;
  onOpenSection: OpenCitation;
}) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [busy, setBusy] = useState(false);
  const [versionsBusy, setVersionsBusy] = useState(false);
  const [result, setResult] = useState<LocateResponse | null>(null);
  const [versions, setVersions] = useState<LocateVersionsResponse | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  async function find(): Promise<void> {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError('');
    setResult(null);
    setVersions(null);
    setVersionsBusy(false);
    setCopied(null);
    try {
      const response = await api.locate(
        detail.doc.docId,
        { text },
        request.signal,
      );
      if (request.signal.aborted) return;
      setSubmitted(text);
      setResult(response);
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!request.signal.aborted) setBusy(false);
    }
  }

  async function earlier(): Promise<void> {
    const request = controller.current ?? new AbortController();
    controller.current = request;
    setVersionsBusy(true);
    setError('');
    try {
      const response = await api.locateVersions(
        detail.doc.docId,
        { text: submitted },
        request.signal,
      );
      if (!request.signal.aborted) setVersions(response);
    } catch (e) {
      if (!request.signal.aborted) setError(errorMessage(e));
    } finally {
      if (!request.signal.aborted) setVersionsBusy(false);
    }
  }

  return (
    <section
      className="locate-card"
      aria-labelledby="locate-title"
      aria-busy={busy}
    >
      <h2 id="locate-title">Find where it says that</h2>
      <form
        className="locate-form"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label htmlFor="locate-sentence">
          Paste a sentence from a news story, press release or post
        </label>
        <div className="locate-input-row">
          <input
            id="locate-sentence"
            type="text"
            value={text}
            minLength={3}
            maxLength={500}
            required
            disabled={busy}
            placeholder="Paste a sentence from a news story, press release or post"
            onChange={(e) => {
              setText(e.target.value);
            }}
          />
          <button
            type="submit"
            className="btn primary"
            disabled={busy || text.trim().length < 3}
          >
            {busy ? 'Finding…' : 'Find passage'}
          </button>
        </div>
      </form>
      {busy && <p role="status">Looking for the exact words…</p>}
      {error && <p role="alert">{error}</p>}
      <div aria-live="polite">
        {result?.status === 'disabled' && (
          <p>This feature is unavailable on this server.</p>
        )}
        {result?.status === 'not-found' && (
          <>
            <p>We couldn't find these words in this version of the bill.</p>
            {result.note && (
              <AnswerText
                text={result.note}
                citations={result.noteCitations ?? []}
                onOpenCitation={onOpenSection}
                citationLabel="Topic source"
              />
            )}
          </>
        )}
        {result?.matches.map((match, i) => {
          const { text: label, icon: Icon } = LABELS[match.label];
          return (
            <article key={match.sectionId} className="locate-match">
              <span className={`locate-label locate-label-${match.label}`}>
                <Icon size={16} aria-hidden="true" />
                {label}
              </span>
              <blockquote>
                <ExcerptSpans spans={match.quote} />
              </blockquote>
              <AnswerText
                text={match.explanation}
                citations={match.citations}
                onOpenCitation={onOpenSection}
                citationLabel={`Passage ${String(i + 1)} source`}
              />
              {match.conditions && (
                <p>
                  <strong>Conditions: </strong>
                  {match.conditions.replace(/\[S:[^\]]+\]/g, '')}
                </p>
              )}
              {match.amends && <p>Changes {match.amends}</p>}
              <button
                type="button"
                className="locate-source"
                onClick={(e) => {
                  onOpenSection(match.sectionId, e.currentTarget);
                }}
              >
                {match.breadcrumb}
              </button>
              <p className="locate-location">
                {describeLocation(match.location, detail.hasLineNumbers)}
              </p>
              <button
                type="button"
                className="btn"
                aria-label={`Copy receipt for passage ${String(i + 1)}`}
                onClick={() => {
                  void copyReceipt(buildReceipt(match, detail)).then(
                    () => {
                      setCopied(match.sectionId);
                    },
                    () => {
                      setError('Could not copy the receipt. Please try again.');
                    },
                  );
                }}
              >
                {copied === match.sectionId ? 'Copied' : 'Copy receipt'}
              </button>
            </article>
          );
        })}
        {result &&
          result.status !== 'disabled' &&
          detail.history?.versions.some((v) => v.url) && (
            <button
              type="button"
              className="btn"
              disabled={busy || versionsBusy}
              onClick={() => {
                void earlier();
              }}
            >
              {versionsBusy ? 'Checking versions…' : 'Check earlier versions'}
            </button>
          )}
        {versions?.status === 'unavailable' && (
          <p>Earlier versions are unavailable.</p>
        )}
        {versions?.status === 'disabled' && (
          <p>Checking earlier versions is unavailable on this server.</p>
        )}
        {versions?.versions.map((v) => (
          <div key={v.url} className="locate-version">
            <p>
              {v.overlap >= 0.7 ? 'Most' : v.overlap > 0 ? 'Some' : 'None'} of
              these words appear in:{' '}
              <a href={v.url} target="_blank" rel="noreferrer">
                {v.label}
                {v.date ? ` (${v.date})` : ''}
              </a>
              .
            </p>
            {v.excerpt && <blockquote>{v.excerpt}</blockquote>}
          </div>
        ))}
      </div>
    </section>
  );
}
