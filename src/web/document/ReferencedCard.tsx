import type { DocDetail } from '../../core/model/index.js';
import { officialUrl } from '../../core/enrich/official-url.js';

type ExternalRef = DocDetail['externalRefs'][number];

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

const label = (ref: ExternalRef): string =>
  ref.category ? CATEGORY_LABEL[ref.category] : KIND_LABEL[ref.kind];

/** Read references first (answers can use them), then the most mentioned. Stable otherwise. */
function ordered(refs: DocDetail['externalRefs']): ExternalRef[] {
  return refs
    .map((ref, index) => ({ ref, index }))
    .sort(
      (a, b) =>
        Number(b.ref.referenceId !== undefined) -
          Number(a.ref.referenceId !== undefined) ||
        b.ref.sectionIds.length - a.ref.sectionIds.length ||
        a.index - b.index,
    )
    .map(({ ref }) => ref);
}

export function ReferencedCard({
  externalRefs,
  onOpenReference,
}: {
  externalRefs: DocDetail['externalRefs'];
  /** Opens the text that was read for a reference (the drawer, on its `ref:` id). */
  onOpenReference?: (referenceId: string, trigger: HTMLElement) => void;
}) {
  if (externalRefs.length === 0) return null;
  const anyRead = externalRefs.some((r) => r.referenceId !== undefined);
  return (
    <section aria-labelledby="refs-title" className="card refs">
      <h3 id="refs-title">Laws it refers to</h3>
      <p className="muted">
        {anyRead
          ? 'Answers can draw on the laws marked "Read" below. The others are only listed, so answers do not use them.'
          : 'This document mentions other laws. They are not loaded here, so answers do not draw on them.'}
      </p>
      <ul className="ref-list" role="list">
        {ordered(externalRefs).map((r) => {
          const href = officialUrl(r.citation);
          const count = r.sectionIds.length;
          return (
            <li key={r.citation}>
              {href ? (
                <a href={href} target="_blank" rel="noopener noreferrer">
                  {r.citation}
                </a>
              ) : (
                <span>{r.citation}</span>
              )}
              <br />
              <small className="muted">
                {label(r)} · mentioned in {count}{' '}
                {count === 1 ? 'section' : 'sections'}
                {r.referenceId !== undefined && onOpenReference ? (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="link-btn"
                      aria-label={`Read: show the text of ${r.citation} that answers use`}
                      onClick={(e) => {
                        if (r.referenceId !== undefined)
                          onOpenReference(r.referenceId, e.currentTarget);
                      }}
                    >
                      Read
                    </button>
                  </>
                ) : null}
              </small>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
