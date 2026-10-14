import { describe, expect, it } from 'vitest';
import { HttpsUrl, SponsorProfile, type SponsorLink } from '../model/index.js';
import type { LegislatorsDirectory } from './legislators.js';
import { enrichSponsorLinks, sponsorProfilesFromNames } from './links.js';

const directory: LegislatorsDirectory = new Map([
  [
    'A000001',
    {
      officialUrl: 'https://alex-adams.house.gov/',
      wikipedia: 'Alex Adams (Ohio)',
      ballotpedia: 'Alex Adams (Ohio)',
    },
  ],
  [
    'A000002',
    {
      officialUrl: 'https://blair-adams.senate.gov/',
      wikipedia: 'Blair Adams',
      ballotpedia: 'Blair Adams',
    },
  ],
  [
    'A000003',
    {
      officialUrl: 'https://alex-adams.senate.gov/',
      wikipedia: 'Alex Adams (Maine)',
      ballotpedia: 'Alex Adams (Maine)',
    },
  ],
]);

function profile(over: Partial<SponsorProfile> = {}): SponsorProfile {
  return { name: 'Alex Adams', role: 'sponsor', links: [], ...over };
}

describe('enrichSponsorLinks', () => {
  it('keeps shared surnames and identical full names in different states apart by id', () => {
    const profiles = [
      profile({ bioguideId: 'A000001', state: 'OH' }),
      profile({
        name: 'Blair Adams',
        role: 'cosponsor',
        bioguideId: 'A000002',
        state: 'ME',
      }),
      profile({ bioguideId: 'A000003', state: 'ME' }),
    ];
    const enriched = enrichSponsorLinks(profiles, directory, 'United States');
    for (const [index, id] of ['A000001', 'A000002', 'A000003'].entries()) {
      expect(enriched[index]!.links).toEqual([
        {
          kind: 'official',
          url: directory.get(id)!.officialUrl,
          label: 'Official website',
          verified: true,
        },
        {
          kind: 'wikipedia',
          url: `https://en.wikipedia.org/wiki/${encodeURIComponent(directory.get(id)!.wikipedia!.replaceAll(' ', '_'))}`,
          label: 'Wikipedia',
          verified: true,
        },
        {
          kind: 'ballotpedia',
          url: `https://ballotpedia.org/${encodeURIComponent(directory.get(id)!.ballotpedia!.replaceAll(' ', '_'))}`,
          label: 'Ballotpedia',
          verified: true,
        },
        {
          kind: 'legislature',
          url: `https://bioguide.congress.gov/search/bio/${id}`,
          label: 'Congressional biography',
          verified: true,
        },
      ]);
      expect(enriched[index]).toEqual({
        ...profiles[index],
        links: enriched[index]!.links,
      });
      expect(SponsorProfile.safeParse(enriched[index]).success).toBe(true);
    }
    expect(profiles.every((p) => p.links.length === 0)).toBe(true);
  });

  it.each([undefined, '', 'A999999', 'a000001'])(
    'uses searches when id %s has no match, even with a matching name',
    (bioguideId) => {
      const [enriched] = enrichSponsorLinks(
        [profile({ bioguideId })],
        directory,
        'Ohio',
      );
      expect(enriched!.links).toEqual([
        {
          kind: 'search',
          url: 'https://ballotpedia.org/wiki/index.php?search=Alex%20Adams%20Ohio',
          label: 'Search Ballotpedia',
          verified: false,
        },
        {
          kind: 'search',
          url: 'https://en.wikipedia.org/w/index.php?search=Alex%20Adams%20Ohio',
          label: 'Search Wikipedia',
          verified: false,
        },
      ]);
    },
  );

  it('does not use a state member id as a federal join key', () => {
    const [enriched] = enrichSponsorLinks(
      [profile({ memberId: 'A000001' })],
      directory,
    );
    expect(
      enriched!.links.every((l) => l.kind === 'search' && !l.verified),
    ).toBe(true);
  });

  it('preserves official Ohio anchors and makes repeated enrichment idempotent', () => {
    const anchor: SponsorLink = {
      kind: 'legislature',
      url: 'https://www.legislature.ohio.gov/members/alex-adams',
      label: 'Ohio member page',
      verified: true,
    };
    const input = profile({
      memberId: 'oh-1',
      links: [anchor],
      party: 'Example',
      district: '2',
      chamber: 'house',
    });
    const once = enrichSponsorLinks([input], directory, 'Ohio');
    expect(once[0]!.links).toEqual([anchor]);
    expect(once[0]).toEqual(input);
    expect(enrichSponsorLinks(once, directory, 'Ohio')).toEqual(once);
    expect(input.links).toEqual([anchor]);
  });

  it('retains the existing label and verification on a duplicate destination', () => {
    const original: SponsorLink = {
      kind: 'official',
      url: 'https://alex-adams.house.gov/',
      label: 'Member website',
      verified: true,
    };
    const [enriched] = enrichSponsorLinks(
      [profile({ bioguideId: 'A000001', links: [original] })],
      directory,
    );
    expect(enriched!.links).toHaveLength(4);
    expect(enriched!.links[0]).toEqual(original);
  });

  it('offers the biography when a matched directory entry has no other fields', () => {
    const [enriched] = enrichSponsorLinks(
      [profile({ bioguideId: 'A000004' })],
      new Map([['A000004', {}]]),
    );
    expect(enriched!.links).toEqual([
      {
        kind: 'legislature',
        url: 'https://bioguide.congress.gov/search/bio/A000004',
        label: 'Congressional biography',
        verified: true,
      },
    ]);
  });

  it('encodes page titles so reserved characters cannot alter the URL', () => {
    const [enriched] = enrichSponsorLinks(
      [profile({ bioguideId: 'A000001' })],
      new Map([
        [
          'A000001',
          { wikipedia: 'Alex / Adams?#é', ballotpedia: 'Alex / Adams?#é' },
        ],
      ]),
    );
    expect(enriched!.links[0]!.url).toBe(
      'https://en.wikipedia.org/wiki/Alex_%2F_Adams%3F%23%C3%A9',
    );
    expect(enriched!.links[1]!.url).toBe(
      'https://ballotpedia.org/Alex_%2F_Adams%3F%23%C3%A9',
    );
    expect(
      enriched!.links.every((l) => HttpsUrl.safeParse(l.url).success),
    ).toBe(true);
  });

  it('encodes name and jurisdiction as one search parameter, with jurisdiction optional', () => {
    const [enriched] = enrichSponsorLinks(
      [profile({ name: 'Alex & Blair #é' })],
      new Map(),
      'City / County?',
    );
    for (const l of enriched!.links) {
      const url = new URL(l.url);
      expect(url.searchParams.get('search')).toBe(
        'Alex & Blair #é City / County?',
      );
      expect(url.searchParams.size).toBe(1);
      expect(url.hash).toBe('');
    }
    const [without] = enrichSponsorLinks([profile()], new Map());
    expect(new URL(without!.links[0]!.url).searchParams.get('search')).toBe(
      'Alex Adams',
    );
  });

  it('rejects non-HTTPS existing and generated links at the contract boundary', () => {
    expect(() =>
      enrichSponsorLinks(
        [
          profile({
            links: [
              {
                kind: 'official',
                url: 'http://example.gov',
                label: 'Bad',
                verified: true,
              },
            ],
          }),
        ],
        directory,
      ),
    ).toThrow();
    expect(() =>
      enrichSponsorLinks(
        [profile({ bioguideId: 'A000001' })],
        new Map([['A000001', { officialUrl: 'http://alex-adams.house.gov' }]]),
      ),
    ).toThrow();
  });

  it('handles no profiles', () => {
    expect(enrichSponsorLinks([], directory)).toEqual([]);
  });
});

describe('sponsorProfilesFromNames', () => {
  it('trims names, drops blank strings and leaves identity and links unset', () => {
    expect(
      sponsorProfilesFromNames([' Alex Adams ', '', ' \n ', 'Blair Adams']),
    ).toEqual([profile(), profile({ name: 'Blair Adams' })]);
  });

  it('accepts the cosponsor role and empty or null metadata names', () => {
    expect(sponsorProfilesFromNames(['Alex Adams'], 'cosponsor')).toEqual([
      profile({ role: 'cosponsor' }),
    ]);
    expect(sponsorProfilesFromNames(null)).toEqual([]);
    expect(sponsorProfilesFromNames([])).toEqual([]);
  });
});
