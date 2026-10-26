import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type {
  DocDetail,
  DocKind,
  OutlineItem,
  ScanStatus,
} from '../../core/model/index.js';
import { SponsorList } from './SponsorList.js';

/** Names the main region while a bill is open (the title itself lives in the masthead). */
export const BILL_TITLE_ID = 'bill-title';

/** Plain labels for local measures. Bills (and "other") keep the plain bill look: no kind line. */
export const DOC_KIND_LABELS: Partial<Record<DocKind, string>> = {
  resolution: 'Resolution',
  charter_amendment: 'Charter amendment',
  ballot_issue: 'Ballot issue',
  ordinance: 'Ordinance',
};

/** "Section 3", "§ 3." and "3" should all find the same outline entry. */
function normalizeSectionNumber(num: string): string {
  const bare = num
    .toLowerCase()
    .replace(/^(?:sections?|sec\.?|§+)\s*/, '')
    .trim();
  // A trailing period ("3.") is punctuation; interior dots ("5747.01") are part of the number.
  return bare.endsWith('.') ? bare.slice(0, -1) : bare;
}

function findOutlineItem(
  outline: readonly OutlineItem[],
  section: string,
  restatedIds?: readonly string[],
): OutlineItem | undefined {
  const wanted = normalizeSectionNumber(section);
  const matches = outline.filter(
    (item) =>
      item.num !== undefined &&
      normalizeSectionNumber(item.num) === wanted &&
      // When the parser says which sections reprint charter text, the measure's own sections
      // are out of the running even if they share the number. Older documents lack the ids.
      (restatedIds === undefined || restatedIds.includes(item.id)),
  );
  // Two sections with one number means the measure's own section shares it with the amended
  // text, and the outline cannot say which is which. Not linking beats opening the wrong one.
  return matches.length === 1 ? matches[0] : undefined;
}

const MARK_TEXT: Record<ScanStatus['pages'][number]['marks'], string> = {
  read: 'marks read',
  uncertain: 'marks uncertain',
  'not-read': 'marks not read',
};

/** One glyph per status, so the status is never carried by color alone. */
function MarkIcon({ marks }: { marks: keyof typeof MARK_TEXT }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.75,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
    focusable: false,
  };
  if (marks === 'read')
    return (
      <svg {...common}>
        <path d="M3 8.5l3.2 3L13 4.5" />
      </svg>
    );
  if (marks === 'uncertain')
    return (
      <svg {...common}>
        <path d="M8 2l6.5 11.5h-13z" />
        <path d="M8 6.5v3M8 11.5v.01" />
      </svg>
    );
  return (
    <svg {...common}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" />
    </svg>
  );
}

/**
 * Warnings that are about reading a scan (the badge already shows them). The parser's wording
 * is free text, so this matches on the words a scan problem uses; other warnings, such as a
 * missing line number, stay in the general list.
 */
const SCAN_WARNING =
  /\b(?:ocr|scanned|this scan|unreadable|(?:could|can|was|were)(?: not|n't) (?:be )?read)\b/i;
export const isScanWarning = (w: string): boolean => SCAN_WARNING.test(w);

/** The title and facts go in the masthead band (`slot`); the notes stay with the page body. */
export function MetadataHeader({
  detail,
  slot = null,
  onOpenSection,
}: {
  detail: DocDetail;
  slot?: HTMLElement | null;
  /** Opens a section in the citation drawer; amended section numbers link to it. */
  onOpenSection?: (sectionId: string, trigger: HTMLElement) => void;
}) {
  const m = detail.metadata;
  const kindLabel = m.docKind ? DOC_KIND_LABELS[m.docKind] : undefined;
  const kindLine = kindLabel
    ? m.jurisdiction
      ? `${kindLabel} · ${m.jurisdiction}`
      : kindLabel
    : null;
  // Only local measures get the line: a state bill that amends a city charter is still a bill,
  // and the line would name the charter alone even when the bill amends other laws too.
  const amends =
    m.docKind && Object.hasOwn(DOC_KIND_LABELS, m.docKind)
      ? m.amends
      : undefined;
  const rows: [string, ReactNode][] = [];
  if (m.billNumber) rows.push(['Number', m.billNumber]);
  // The kind line already names the jurisdiction, so the row would only repeat it.
  if (m.jurisdiction && !kindLine) rows.push(['Jurisdiction', m.jurisdiction]);
  if (m.session) rows.push(['Session', m.session]);
  if (m.version) rows.push(['Version', m.version]);
  if (m.sponsors && m.sponsors.length > 0)
    rows.push([
      'Sponsors',
      <SponsorList names={m.sponsors} profiles={m.sponsorProfiles} />,
    ]);
  const identity = (
    <div className="doc-header">
      {kindLine && <p className="doc-kind">{kindLine}</p>}
      <h2 id={BILL_TITLE_ID}>{m.title ?? detail.doc.label}</h2>
      {amends && (
        <p className="doc-amends">
          <span className="doc-amends-label">Amends:</span> {amends.name}
          {amends.sections.length > 0 && (
            <>
              {' '}
              {amends.sections.length === 1 ? '§' : '§§'}{' '}
              {amends.sections.map((section, i) => {
                const item = onOpenSection
                  ? findOutlineItem(detail.outline, section, amends.sectionIds)
                  : undefined;
                return (
                  <span key={`${section}-${String(i)}`}>
                    {i > 0 && ', '}
                    {item && onOpenSection ? (
                      <button
                        type="button"
                        className="doc-amends-link"
                        aria-label={`Section ${section} of the ${amends.name}`}
                        onClick={(e) => {
                          onOpenSection(item.id, e.currentTarget);
                        }}
                      >
                        {section}
                      </button>
                    ) : (
                      section
                    )}
                  </span>
                );
              })}
            </>
          )}
        </p>
      )}
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
  const scan = detail.scan;
  const scanWarnings = scan ? detail.warnings.filter(isScanWarning) : [];
  const otherWarnings = scan
    ? detail.warnings.filter((w) => !isScanWarning(w))
    : detail.warnings;
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
        {scan && (
          <section className="scan-badge" aria-labelledby="scan-badge-title">
            <h3 id="scan-badge-title">Scanned document</h3>
            <p>
              This file is a scan, so the text was read from images of the
              pages. Marks (strikethrough and underline) may be missed or
              misread; check the page itself where it matters.
            </p>
            {scan.pages.length > 0 && (
              <ul className="scan-pages">
                {scan.pages.map(({ page, marks }) => (
                  <li key={page} className={`scan-page scan-${marks}`}>
                    <MarkIcon marks={marks} />
                    <span>
                      Page {page}: {MARK_TEXT[marks]}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {scanWarnings.map((w) => (
              <p key={w} className="scan-warning">
                {w}
              </p>
            ))}
          </section>
        )}
        {otherWarnings.map((w) => (
          <p key={w} className="note">
            {w}
          </p>
        ))}
      </div>
    </>
  );
}
