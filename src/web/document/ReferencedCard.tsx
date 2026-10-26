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

const ORC = 'https://codes.ohio.gov/ohio-revised-code';

/**
 * A link to the official code site, only when the citation maps cleanly. No search engines:
 * they would learn what the reader is looking at. Charter and city code get no link.
 */
export function officialUrl(citation: string): string | undefined {
  if (citation === 'Ohio Revised Code, Title 35') return `${ORC}/title-35`;
  const section = /^R\.C\. (\d+\.\d+(?:\.\d+)?)$/.exec(citation);
  if (section) return `${ORC}/section-${encodeURIComponent(section[1] ?? '')}`;
  const chapter = /^R\.C\. Chapter (\d+(?:\.\d+)?)$/.exec(citation);
  if (chapter) return `${ORC}/chapter-${encodeURIComponent(chapter[1] ?? '')}`;
  return undefined;
}

export function ReferencedCard({
  externalRefs,
}: {
  externalRefs: DocDetail['externalRefs'];
}) {
  if (externalRefs.length === 0) return null;
  return (
    <section aria-labelledby="refs-title" className="card refs">
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
            {(() => {
              const href = officialUrl(r.citation);
              return href ? (
                <>
                  {' '}
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`View ${r.citation} on codes.ohio.gov`}
                  >
                    View on codes.ohio.gov
                  </a>
                </>
              ) : null;
            })()}
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
