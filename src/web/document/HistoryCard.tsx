import type { BillHistory } from '../../core/model/index.js';
import { formatRecordDate } from '../format-date.js';

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

const STATUS_TEXT = {
  adopted: 'Adopted',
  offered: 'Offered',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  unknown: 'Status not recorded',
} as const;

function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * "How did it get here?" from the official record. Nothing is inferred: a field the record
 * leaves out is left out here too, and people are named only where the record names them.
 */
export function HistoryCard({ history }: { history: BillHistory | undefined }) {
  const versions = history ? byDate(history.versions) : [];
  const actions = history ? byDate(history.actions) : [];
  const [firstAction, ...laterActions] = actions;
  const keyActions =
    firstAction && actions.length > RECENT_ACTIONS + 1
      ? [firstAction, ...laterActions.slice(-RECENT_ACTIONS)]
      : actions;
  const amendments = history?.amendments ?? [];
  const empty =
    !history ||
    (versions.length === 0 && actions.length === 0 && amendments.length === 0);
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
            </p>
          )}
        </>
      )}
      {amendments.length > 0 && (
        <>
          <h4>Amendments</h4>
          <ul className="timeline">
            {amendments.map((a) => (
              <li key={a.id}>
                <span className="when">
                  {STATUS_TEXT[a.status]}
                  {a.date ? `, ${formatRecordDate(a.date)}` : ''}
                </span>
                <span>
                  {a.number ? `Amendment ${a.number}` : 'Amendment'}
                  {a.sponsor ? ` by ${a.sponsor.name}` : ''}
                  {a.committee ? ` (${a.committee})` : ''}
                  {a.purpose || a.description
                    ? `: ${a.purpose ?? a.description ?? ''}`
                    : ''}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {!empty && (
        <p className="muted history-note">
          From the official record. People are named only when the record names
          them.
        </p>
      )}
    </section>
  );
}
