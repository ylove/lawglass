import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DocDetail } from '../../core/model/index.js';

// Its own component so later work (sponsor links) can extend it without touching the rows.
export function SponsorList({ sponsors }: { sponsors: string[] }) {
  return <>{sponsors.join(', ')}</>;
}

/** The title and facts go in the masthead band (`slot`); the notes stay with the page body. */
export function MetadataHeader({
  detail,
  slot = null,
}: {
  detail: DocDetail;
  slot?: HTMLElement | null;
}) {
  const m = detail.metadata;
  const rows: [string, ReactNode][] = [];
  if (m.billNumber) rows.push(['Number', m.billNumber]);
  if (m.jurisdiction) rows.push(['Jurisdiction', m.jurisdiction]);
  if (m.session) rows.push(['Session', m.session]);
  if (m.version) rows.push(['Version', m.version]);
  if (m.sponsors && m.sponsors.length > 0)
    rows.push(['Sponsors', <SponsorList sponsors={m.sponsors} />]);
  const identity = (
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
    </div>
  );
  return (
    <>
      {slot ? createPortal(identity, slot) : identity}
      <div className="doc-notes">
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
    </>
  );
}
