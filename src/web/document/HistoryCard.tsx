import type { BillHistory } from '../../core/model/index.js';
import { formatRecordDate } from '../format-date.js';
import { ExternalLink, officialSiteName } from './ExternalLink.js';

/** The first action plus the latest few; a long floor history would otherwise bury the card. */
const RECENT_ACTIONS = 3;

function byDate<T extends { date?: string | undefined }>(items: T[]): T[] {
  // Stable sort; undated entries keep their recorded order at the end.
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const x = a.item.date ?? '9999';
      const y = b.item.date ?? '9999';
      return x < y ? -1 : x > y ? 1 : a.i - b.i;
    })
    .map((e) => e.item);
}

/**
 * "How did it get here?" from the official record. Nothing is inferred: a field the record
 * leaves out is left out here too, and people are named only where the record names them.
 */
export function HistoryCard({
  history,
  allActionsUrl,
}: {
  history: BillHistory | undefined;
  /** The official site's full list of actions (`DocDetail.historyLinks.actions`), when known. */
  allActionsUrl?: string | undefined;
}) {
  const versions = history ? byDate(history.versions) : [];
  const actions = history ? byDate(history.actions) : [];
  // Each chamber can file the same event ("Signed by President." twice on one day). The card
  // shows date and text only, so it shows such an event once; the count below stays the record's.
  const distinct = actions.filter(
    (a, i) =>
      actions.findIndex((b) => b.date === a.date && b.text === a.text) === i,
  );
  const [firstAction, ...laterActions] = distinct;
  const keyActions =
    firstAction && distinct.length > RECENT_ACTIONS + 1
      ? [firstAction, ...laterActions.slice(-RECENT_ACTIONS)]
      : distinct;
  const hasAmendments = (history?.amendments.length ?? 0) > 0;
  const empty = versions.length === 0 && actions.length === 0;
  // Amendments have their own card; with only those on record this one has nothing to say.
  if (empty && hasAmendments) return null;
  return (
    <section aria-labelledby="history-title" className="card history">
      <h3 id="history-title">How did it get here?</h3>
      {empty && (
        <p className="muted">
          The official history is not available for this document.
        </p>
      )}
      {versions.length > 0 && (
        <>
          <h4>Versions</h4>
          <ol className="timeline">
            {versions.map((v) => (
              <li key={v.code}>
                {v.date && (
                  <span className="when">{formatRecordDate(v.date)}</span>
                )}
                <span>
                  {v.url ? (
                    <ExternalLink href={v.url}>{v.label}</ExternalLink>
                  ) : (
                    v.label
                  )}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
      {keyActions.length > 0 && (
        <>
          <h4>Key actions</h4>
          <ol className="timeline">
            {keyActions.map((a, i) => (
              <li key={`${a.date}-${String(i)}`}>
                <span className="when">{formatRecordDate(a.date)}</span>
                <span>{a.text}</span>
              </li>
            ))}
          </ol>
          {actions.length > keyActions.length && (
            <p className="muted history-more">
              Showing {keyActions.length} of {actions.length} recorded actions.
              {allActionsUrl && (
                <>
                  {' '}
                  <ExternalLink href={allActionsUrl}>
                    {`See all ${String(actions.length)} on ${officialSiteName(allActionsUrl)}`}
                  </ExternalLink>
                </>
              )}
            </p>
          )}
        </>
      )}
    </section>
  );
}
