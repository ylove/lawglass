import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DocDetail } from '../../core/model/index.js';
import { SponsorList } from './SponsorList.js';

/** Names the main region while a bill is open (the title itself lives in the masthead). */
export const BILL_TITLE_ID = 'bill-title';

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
    rows.push([
      'Sponsors',
      <SponsorList names={m.sponsors} profiles={m.sponsorProfiles} />,
    ]);
  const identity = (
    <div className="doc-header">
      <h2 id={BILL_TITLE_ID}>{m.title ?? detail.doc.label}</h2>
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
