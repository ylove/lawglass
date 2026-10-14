import { HttpsUrl, SponsorLink, SponsorProfile } from '../model/index.js';
import type { LegislatorsDirectory } from './legislators.js';

function link(
  kind: SponsorLink['kind'],
  url: string,
  label: string,
  verified: boolean,
): SponsorLink {
  return SponsorLink.parse({ kind, url: HttpsUrl.parse(url), label, verified });
}

function pageTitle(title: string): string {
  return encodeURIComponent(title.replaceAll(' ', '_'));
}

function searchLinks(name: string, jurisdiction?: string): SponsorLink[] {
  const query = encodeURIComponent(
    [name, jurisdiction].filter(Boolean).join(' '),
  );
  return [
    link(
      'search',
      `https://ballotpedia.org/wiki/index.php?search=${query}`,
      'Search Ballotpedia',
      false,
    ),
    link(
      'search',
      `https://en.wikipedia.org/w/index.php?search=${query}`,
      'Search Wikipedia',
      false,
    ),
  ];
}

/** Enrich by bioguide id only; existing official-record links retain their labels and evidence. */
export function enrichSponsorLinks(
  profiles: readonly SponsorProfile[],
  directory: LegislatorsDirectory,
  jurisdiction?: string,
): SponsorProfile[] {
  return profiles.map((input) => {
    const profile = SponsorProfile.parse(input);
    const bioguideId = profile.bioguideId;
    const member = bioguideId ? directory.get(bioguideId) : undefined;
    const added: SponsorLink[] = [];
    if (member && bioguideId) {
      if (member.officialUrl)
        added.push(
          link('official', member.officialUrl, 'Official website', true),
        );
      if (member.wikipedia)
        added.push(
          link(
            'wikipedia',
            `https://en.wikipedia.org/wiki/${pageTitle(member.wikipedia)}`,
            'Wikipedia',
            true,
          ),
        );
      if (member.ballotpedia)
        added.push(
          link(
            'ballotpedia',
            `https://ballotpedia.org/${pageTitle(member.ballotpedia)}`,
            'Ballotpedia',
            true,
          ),
        );
      added.push(
        link(
          'legislature',
          `https://bioguide.congress.gov/search/bio/${encodeURIComponent(bioguideId)}`,
          'Congressional biography',
          true,
        ),
      );
    } else if (!profile.links.some((existing) => existing.kind !== 'search')) {
      added.push(...searchLinks(profile.name, jurisdiction));
    }
    const seen = new Set(profile.links.map((existing) => existing.url));
    for (const candidate of added) {
      if (!seen.has(candidate.url)) {
        profile.links.push(candidate);
        seen.add(candidate.url);
      }
    }
    return profile;
  });
}

/** Metadata names carry no identity evidence, so these profiles deliberately have no ids. */
export function sponsorProfilesFromNames(
  names: readonly string[] | null,
  role: SponsorProfile['role'] = 'sponsor',
): SponsorProfile[] {
  return (names ?? [])
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => SponsorProfile.parse({ name, role, links: [] }));
}
