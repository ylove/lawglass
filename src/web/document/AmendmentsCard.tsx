import type { BillHistory } from '../../core/model/index.js';
import { formatRecordDate } from '../format-date.js';
import { ExternalLink, officialSiteName } from './ExternalLink.js';

type Amendment = BillHistory['amendments'][number];

/**
 * Up to this many, each amendment is listed. Beyond it a list stops being readable (a Senate
 * bill can draw hundreds), so amendments are counted per sponsor instead.
 */
const LIST_LIMIT = 6;
/** Sponsors shown before the rest fold into a disclosure. */
const TOP_SPONSORS = 8;

const STATUS_TEXT = {
  adopted: 'Adopted',
  offered: 'Offered',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  unknown: 'Status not recorded',
} as const;

/** Order of the "(1 adopted, 3 withdrawn)" tally. "unknown" is deliberately never counted. */
const TALLIED = ['adopted', 'rejected', 'withdrawn', 'offered'] as const;

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * The Ohio adapter writes "Amendment am123 (version)" as the description, which would repeat
 * the number the line already starts with. Drop that restatement and keep the version and any
 * further wording, e.g. "Also sponsored by X".
 */
export function describeAmendment(a: Amendment): {
  version?: string;
  detail?: string;
} {
  if (a.purpose) return { detail: a.purpose };
  if (!a.description) return {};
  let text = a.description.trim();
  if (a.number) {
    const restated = `Amendment ${a.number}`;
    if (text.toLowerCase().startsWith(restated.toLowerCase()))
      text = text.slice(restated.length).trim();
  }
  const version = /^(\([^)]*\))(.*)$/.exec(text);
  // What follows the version is joined by a full stop ("(v1). Also sponsored by X").
  const detail = (version ? version[2] : text)
    ?.trim()
    .replace(/^\./, '')
    .trim();
  return {
    ...(version?.[1] ? { version: version[1] } : {}),
    ...(detail ? { detail } : {}),
  };
}

interface SponsorGroup {
  name: string;
  count: number;
  tally: Record<(typeof TALLIED)[number], number>;
}

/** Group by the sponsor name exactly as recorded; sorted by count, then name, so it is stable. */
export function groupBySponsor(amendments: readonly Amendment[]): {
  named: SponsorGroup[];
  unsponsored: SponsorGroup | undefined;
} {
  const groups = new Map<string, SponsorGroup>();
  let unsponsored: SponsorGroup | undefined;
  for (const a of amendments) {
    let group: SponsorGroup | undefined;
    if (a.sponsor) {
      group = groups.get(a.sponsor.name);
      if (!group) {
        group = newGroup(a.sponsor.name);
        groups.set(a.sponsor.name, group);
      }
    } else {
      group = unsponsored ??= newGroup('No sponsor recorded');
    }
    group.count += 1;
    if (a.status !== 'unknown') group.tally[a.status] += 1;
  }
  return {
    named: [...groups.values()].sort(
      (a, b) => b.count - a.count || a.name.localeCompare(b.name),
    ),
    unsponsored,
  };
}

function newGroup(name: string): SponsorGroup {
  return {
    name,
    count: 0,
    tally: { adopted: 0, rejected: 0, withdrawn: 0, offered: 0 },
  };
}

function tallyText(group: SponsorGroup): string {
  const parts = TALLIED.filter((s) => group.tally[s] > 0).map(
    (s) => `${String(group.tally[s])} ${s}`,
  );
  return parts.length ? `(${parts.join(', ')})` : '';
}

function SponsorRow({ group }: { group: SponsorGroup }) {
  const tally = tallyText(group);
  return (
    <li>
      <span>{`${group.name} · ${plural(group.count, 'amendment')}`}</span>
      {tally && <span className="when">{tally}</span>}
    </li>
  );
}

function AmendmentRow({ a }: { a: Amendment }) {
  const label = a.number ? `Amendment ${a.number}` : 'Amendment';
  const { version, detail } = describeAmendment(a);
  return (
    <li>
      <span className="when">
        {STATUS_TEXT[a.status]}
        {a.date ? `, ${formatRecordDate(a.date)}` : ''}
      </span>
      <span>
        {a.url ? <ExternalLink href={a.url}>{label}</ExternalLink> : label}
        {version ? ` ${version}` : ''}
        {a.sponsor ? ` by ${a.sponsor.name}` : ''}
        {a.committee ? ` (${a.committee})` : ''}
        {detail ? `: ${detail}` : ''}
      </span>
    </li>
  );
}

/**
 * The bill's amendments, shown after "Laws it refers to" because what a bill changes matters
 * more to most readers than who tried to change it. Few amendments are listed one by one; many
 * are counted per sponsor, with a link to the full list on the official site.
 */
export function AmendmentsCard({
  history,
  allAmendmentsUrl,
}: {
  history: BillHistory | undefined;
  allAmendmentsUrl?: string | undefined;
}) {
  const amendments = history?.amendments ?? [];
  if (amendments.length === 0) return null;
  const aggregate = amendments.length > LIST_LIMIT;
  const { named, unsponsored } = groupBySponsor(amendments);
  const shown = named.slice(0, TOP_SPONSORS);
  const rest = named.slice(TOP_SPONSORS);
  return (
    <section aria-labelledby="amendments-title" className="card history">
      <h3 id="amendments-title">Amendments</h3>
      {aggregate ? (
        <>
          <p className="muted history-more">
            {`${plural(amendments.length, 'amendment')} from ${plural(named.length, 'sponsor')}`}
          </p>
          <ul className="timeline">
            {shown.map((g) => (
              <SponsorRow key={g.name} group={g} />
            ))}
            {unsponsored && <SponsorRow group={unsponsored} />}
          </ul>
          {rest.length > 0 && (
            <details className="history-details">
              <summary>{`Show ${plural(rest.length, 'more sponsor')}`}</summary>
              <ul className="timeline">
                {rest.map((g) => (
                  <SponsorRow key={g.name} group={g} />
                ))}
              </ul>
            </details>
          )}
        </>
      ) : (
        <ul className="timeline">
          {amendments.map((a) => (
            <AmendmentRow key={a.id} a={a} />
          ))}
        </ul>
      )}
      {allAmendmentsUrl && (
        <p className="history-more">
          <ExternalLink href={allAmendmentsUrl}>
            {`See all ${plural(amendments.length, 'amendment')} on ${officialSiteName(allAmendmentsUrl)}`}
          </ExternalLink>
        </p>
      )}
      <p className="muted history-note">
        From the official record. People are named only when the record names
        them.
      </p>
    </section>
  );
}
