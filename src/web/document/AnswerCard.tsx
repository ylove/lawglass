import type { AnswerWarning } from '../../core/model/index.js';
import { AnswerBodyBoundary } from '../AnswerBodyBoundary.js';
import { AnswerText, stripMarkers } from '../AnswerText.js';
import { describeLocation } from '../CitationDrawer.js';
import { ScenarioStrip } from './ScenarioStrip.js';
import type { Phase, Turn } from './types.js';

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

export function AnswerCard({
  turn,
  busy,
  hasLineNumbers,
  onOpenSection,
}: {
  turn: Turn | null;
  busy: boolean;
  hasLineNumbers: boolean;
  /** Opens the citation drawer; `trigger` is where focus returns when it closes. */
  onOpenSection: (sectionId: string, trigger: HTMLElement) => void;
}) {
  const citations = turn?.result?.citations.filter((c) => c.valid) ?? [];
  return (
    <section aria-labelledby="answer-title" className="answer card">
      <h3 id="answer-title">Answer</h3>
      {!turn && (
        <p className="muted">Choose a question above to see an answer here.</p>
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
            <AnswerBodyBoundary
              // Reset for each question, but retain the fallback as its answer streams.
              key={turn.id}
              text={turn.result?.text ?? turn.text}
            >
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
                  onOpenCitation={onOpenSection}
                />
              )}
            </AnswerBodyBoundary>
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
          {turn.phase === 'done' && turn.scenario && (
            <ScenarioStrip
              scenario={turn.scenario}
              onOpenSection={onOpenSection}
            />
          )}
          {turn.phase === 'done' && citations.length > 0 && (
            <div className="sources">
              <h4>Sources</h4>
              <ol role="list">
                {citations.map((c) => (
                  <li key={c.sectionId}>
                    <button
                      type="button"
                      className="link-btn"
                      onClick={(e) => {
                        onOpenSection(c.sectionId, e.currentTarget);
                      }}
                    >
                      {c.breadcrumb ?? c.sectionId}
                    </button>
                    {c.location && (
                      <span className="muted">
                        {' '}
                        - {describeLocation(c.location, hasLineNumbers)}
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
  );
}
