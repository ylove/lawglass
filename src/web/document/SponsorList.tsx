import type { SponsorLink, SponsorProfile } from '../../core/model/index.js';

/** Best verified link first: the person's own page beats an encyclopedia beats a roster. */
const PREFERENCE = [
  'official',
  'wikipedia',
  'ballotpedia',
  'legislature',
] as const;

const KIND_LABEL: Record<(typeof PREFERENCE)[number], string> = {
  official: 'official page',
  wikipedia: 'Wikipedia',
  ballotpedia: 'Ballotpedia',
  legislature: 'legislature page',
};

export interface PickedLink {
  url: string;
  /** Small text shown next to the name; says plainly when it is only a search. */
  label: string;
  verified: boolean;
}

/** Chooses the link to show for one sponsor, or null when the record has none. */
export function pickSponsorLink(
  links: readonly SponsorLink[],
): PickedLink | null {
  for (const kind of PREFERENCE) {
    const hit = links.find((l) => l.verified && l.kind === kind);
    if (hit) return { url: hit.url, label: KIND_LABEL[kind], verified: true };
  }
  const search = links.find((l) => l.kind === 'search');
  if (!search) return null;
  const host = new URL(search.url).hostname;
  return {
    url: search.url,
    label: host.includes('ballotpedia')
      ? 'search Ballotpedia'
      : 'search the web',
    verified: false,
  };
}

function Sponsor({ profile }: { profile: SponsorProfile }) {
  const link = pickSponsorLink(profile.links);
  if (!link) return <span className="sponsor">{profile.name}</span>;
  return (
    <a
      className="sponsor"
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
    >
      {profile.name}
      <small className="sponsor-kind"> {link.label}</small>
    </a>
  );
}

/**
 * The sponsors line in the masthead. Uses verified profiles when the server has them and falls
 * back to the plain names from the document. Cosponsors sit in a disclosure to keep it short.
 */
export function SponsorList({
  names,
  profiles,
}: {
  names: string[];
  profiles?: SponsorProfile[] | undefined;
}) {
  if (!profiles || profiles.length === 0) return <>{names.join(', ')}</>;
  const lead = profiles.filter((p) => p.role === 'sponsor');
  const others = profiles.filter((p) => p.role === 'cosponsor');
  return (
    <span className="sponsors">
      <span className="sponsor-row">
        {lead.map((p, i) => (
          <Sponsor key={`${p.role}-${p.name}-${String(i)}`} profile={p} />
        ))}
      </span>
      {others.length > 0 && (
        <details className="cosponsors">
          <summary>
            {lead.length > 0 ? 'and ' : ''}
            {others.length} {others.length === 1 ? 'cosponsor' : 'cosponsors'}
          </summary>
          <span className="sponsor-row">
            {others.map((p, i) => (
              <Sponsor key={`${p.role}-${p.name}-${String(i)}`} profile={p} />
            ))}
          </span>
        </details>
      )}
    </span>
  );
}
