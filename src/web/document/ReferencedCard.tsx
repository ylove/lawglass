import type { DocDetail } from '../../core/model/index.js';

const KIND_LABEL = {
  us_code: 'Federal law',
  public_law: 'Public law',
  state_code: 'State law',
  cfr: 'Federal regulation',
  other: 'Other law',
} as const;

/** Category wins over kind: charter and city-code refs are all `kind: other`. */
const CATEGORY_LABEL = {
  charter: 'City charter',
  local_code: 'City code',
  general_law: 'State law',
} as const;

export function ReferencedCard({
  externalRefs,
}: {
  externalRefs: DocDetail['externalRefs'];
}) {
  if (externalRefs.length === 0) return null;
  return (
    <section aria-labelledby="refs-title" className="card">
      <h3 id="refs-title">Referenced, not loaded</h3>
      <p className="muted">
        This document mentions other laws. They are not loaded here, so answers
        do not draw on them.
      </p>
      <ul>
        {externalRefs.map((r) => (
          <li key={r.citation}>
            <strong>{r.citation}</strong>{' '}
            <span className="muted">
              ({r.category ? CATEGORY_LABEL[r.category] : KIND_LABEL[r.kind]})
            </span>
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
  );
}
