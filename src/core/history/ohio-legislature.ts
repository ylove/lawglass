import { z } from 'zod';
import { AppError, BillHistory, SponsorProfile } from '../model/index.js';
import { MAX_NAME, MAX_TEXT, sanitizeText } from './text.js';
import type { HistoryPlan, HistoryRecord, HistorySource } from './resolve.js';

/**
 * Ohio history comes from the legislature's own LIS JSON API on search-prod.lis.state.oh.us
 * (the same host the bill text comes from), under
 * `/api/v2/general_assembly_<ga>/legislation/<bill>/`:
 *
 * - `` (the bill): one object per version, with `version`, `version_id`,
 *   `formatted_version`, `long_title`, signing/effective dates and `sponsors[]`/`cosponsors[]`.
 *   Required: versions come only from here.
 * - `actions/`: dated journal actions (introduced, passed, reported, conference...).
 * - `meetings/`: committee meeting notices (date, committee, chamber, `canceled`).
 * - `amendments/`: amendment numbers, the version amended and their sponsors. Often empty.
 *
 * There is no members endpoint with member-page URLs, so sponsors keep only `memberId`.
 * The last three are optional: if one fails the history is kept and marked partial.
 *
 * We never fetch www.legislature.ohio.gov. It serves the wrong intermediate certificate,
 * so Node cannot verify it, and we will not weaken TLS. Its bill URLs are only recognised
 * and mapped to the API.
 *
 * Every string returned here comes from a remote record. Consumers must render it as
 * text, never as HTML. Tags, invisible characters and over-long values are removed on the
 * way in as a second line of defence (see ./text.ts).
 *
 * Stored versions are oldest first.
 */
const LANDING_HOST = 'www.legislature.ohio.gov';
const API_HOST = 'search-prod.lis.state.oh.us';
const VERSION = /^[0-9]{2}_[A-Z]{2}$/;
const BILL = '(?:hb|sb|hjr|sjr|hcr|scr|hr|sr)[1-9][0-9]{0,5}';
const LANDING = new RegExp(
  `^/legislation/([1-9][0-9]{0,2})/(${BILL})(?:/(?:status|documents|committee))?/?$`,
);
const TEXT = new RegExp(
  `^/api/v2/general_assembly_([1-9][0-9]{0,2})/legislation/(${BILL})/([0-9]{2}_[A-Z]{2})/pdf/?$`,
);

export interface OhioPlan extends HistoryPlan {
  source: 'ohio';
  ga: string;
  bill: string;
}

function apiBase(plan: OhioPlan): string {
  return `https://${API_HOST}/api/v2/general_assembly_${plan.ga}/legislation/${plan.bill}/`;
}

/** Only identities and version codes enter constructed URLs, never URLs from the record. */
export function ohioTextUrl(plan: OhioPlan, version: string): string {
  if (!VERSION.test(version)) throw new AppError('INVALID_INPUT');
  return `${apiBase(plan)}${version}/pdf/`;
}

/** The landing host, with or without `www` or a trailing dot. Never fetched. */
export function isOhioLandingHost(url: URL): boolean {
  const host = url.hostname.replace(/\.+$/, '');
  return host === LANDING_HOST || host === 'legislature.ohio.gov';
}
export function ohioPageError(): AppError {
  return new AppError('INVALID_INPUT', undefined, {
    userMessage:
      'Paste an Ohio bill URL such as https://www.legislature.ohio.gov/legislation/135/hb9001, or a search-prod.lis.state.oh.us bill text URL.',
  });
}

export function resolveOhio(url: URL): OhioPlan | undefined {
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    /%|\\/.test(url.pathname)
  )
    return undefined;
  const match =
    url.hostname === LANDING_HOST
      ? LANDING.exec(url.pathname)
      : url.hostname === API_HOST
        ? TEXT.exec(url.pathname)
        : null;
  if (!match?.[1] || !match[2]) return undefined;
  const plan: OhioPlan = { source: 'ohio', ga: match[1], bill: match[2] };
  if (match[3]) {
    plan.version = match[3];
    plan.textUrl = ohioTextUrl(plan, match[3]);
  }
  return plan;
}

/** Kept as a named export for the adapter's tests; the work is in the shared helper. */
export const plainText = sanitizeText;

const Text = z.string().transform((v) => sanitizeText(v, MAX_TEXT));
const Name = z.string().transform((v) => sanitizeText(v, MAX_NAME));
const OptionalText = Text.nullish().transform((v) =>
  v?.length ? v : undefined,
);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

const Member = z.object({
  full_name: Name.pipe(z.string().min(1)),
  member_id: z.union([z.number(), z.string()]).nullish(),
  party: OptionalText,
  district: z.union([z.number(), z.string()]).nullish(),
  chamber: OptionalText,
});
const VersionRecord = z.object({
  number: OptionalText,
  version: Text,
  version_id: z.string().regex(/^[A-Z]{2}$/),
  formatted_version: z.string().regex(/^[0-9]{2}$/),
  long_title: OptionalText,
  effective_date: IsoDate.nullish(),
  governor_signed_date: IsoDate.nullish(),
  sponsors: z.array(Member).default([]),
  cosponsors: z.array(Member).default([]),
});
const ActionRecord = z.object({
  occurred: IsoDate,
  chamber: OptionalText,
  action: Text.pipe(z.string().min(1)),
  cmte_name: OptionalText,
  committee: OptionalText,
});
const MeetingRecord = z.object({
  meeting_date: IsoDate,
  committee: Text.pipe(z.string().min(1)),
  chamber: OptionalText,
  canceled: z.boolean().nullish(),
});
const AmendmentRecord = z.object({
  amendment_number: z.string().regex(/^am[0-9]{1,8}$/),
  version: OptionalText,
  sponsors: z.array(Member).default([]),
});
const VersionList = z.array(VersionRecord).min(1);
const ActionList = z.array(ActionRecord);
const MeetingList = z.array(MeetingRecord);
const AmendmentList = z.array(AmendmentRecord);

/** An optional part that is missing or malformed becomes `undefined`, and the caller marks the history partial. */
function optionalJson<T>(
  schema: z.ZodType<T>,
  bytes: Uint8Array | undefined,
): T | undefined {
  if (!bytes) return undefined;
  try {
    return json(schema, bytes);
  } catch {
    return undefined;
  }
}

function json<T>(schema: z.ZodType<T>, bytes: Uint8Array): T {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new AppError('PARSE_FAILED');
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AppError('PARSE_FAILED');
  return parsed.data;
}

const day = (value: string): string => value.slice(0, 10);
const capitalize = (value: string | undefined): string | undefined =>
  value
    ? value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
    : undefined;

const PARTIES: Readonly<Record<string, string>> = {
  democrat: 'Democrat',
  republican: 'Republican',
  independent: 'Independent',
};
/** `party_democrat_1` becomes "Democrat". An unrecognised code is left out, not guessed. */
export function partyLabel(code: string | undefined): string | undefined {
  return PARTIES[/^party_([a-z]+)_\d+$/.exec(code ?? '')?.[1] ?? ''];
}

function sponsorProfiles(
  members: readonly z.infer<typeof Member>[],
  role: SponsorProfile['role'],
): SponsorProfile[] {
  return members.map((member) => {
    const chamber = member.chamber?.toLowerCase();
    return SponsorProfile.parse({
      name: member.full_name,
      role,
      party: partyLabel(member.party),
      district: member.district == null ? undefined : String(member.district),
      chamber:
        chamber === 'house' || chamber === 'senate' ? chamber : undefined,
      memberId: member.member_id == null ? undefined : String(member.member_id),
      // The LIS API gives no member-page URL. The sponsor link builder adds labeled searches.
      links: [],
    });
  });
}

export function parseOhioHistory(
  responses: {
    versions: Uint8Array;
    actions: Uint8Array | undefined;
    meetings: Uint8Array | undefined;
    amendments: Uint8Array | undefined;
  },
  plan: OhioPlan,
  fetchedAt: string,
): HistoryRecord {
  const records = json(VersionList, responses.versions);
  if (records.some((r) => r.number && r.number !== plan.bill))
    throw new AppError('PARSE_FAILED');
  const base = apiBase(plan);
  // Stored versions are oldest first: the numeric prefix is the stage (00 introduced ... enrolled last).
  const ordered = [...records].sort((a, b) =>
    `${a.formatted_version}_${a.version_id}`.localeCompare(
      `${b.formatted_version}_${b.version_id}`,
    ),
  );
  const versions: BillHistory['versions'] = ordered.map((r) => {
    const code = `${r.formatted_version}_${r.version_id}`;
    return { code, label: r.version, url: ohioTextUrl(plan, code) };
  });

  const actionList = optionalJson(ActionList, responses.actions);
  const meetingList = optionalJson(MeetingList, responses.meetings);
  const amendmentList = optionalJson(AmendmentList, responses.amendments);
  const actions: BillHistory['actions'] = [
    ...(actionList ?? []).map((a) => ({
      date: day(a.occurred),
      text: a.action,
      chamber: a.chamber,
      committee: a.cmte_name ?? a.committee,
      url: `${base}actions/`,
    })),
    ...(meetingList ?? [])
      .filter((m) => !m.canceled)
      .map((m) => ({
        date: day(m.meeting_date),
        text: `On the ${m.committee} meeting agenda`,
        chamber: capitalize(m.chamber),
        committee: m.committee,
        url: `${base}meetings/`,
      })),
  ];
  // Signing and effective dates sit on the version they apply to.
  for (const r of ordered) {
    if (r.governor_signed_date)
      actions.push({
        date: day(r.governor_signed_date),
        text: 'Signed by the Governor',
        url: base,
      });
    if (r.effective_date)
      actions.push({
        date: day(r.effective_date),
        text: 'Effective date',
        url: base,
      });
  }
  // Oldest first; the sort is stable so same-day entries keep the record's order.
  actions.sort((a, b) => a.date.localeCompare(b.date));

  // The record states no amendment date or committee, so none is claimed. Its own sponsor
  // list is the official attribution: the first becomes the sponsor, any others are
  // named in the description.
  const amendments: BillHistory['amendments'] = (amendmentList ?? []).map(
    (a) => {
      const [first, ...others] = a.sponsors;
      const label = a.version
        ? `Amendment ${a.amendment_number} (${a.version})`
        : `Amendment ${a.amendment_number}`;
      return {
        id: a.amendment_number,
        number: a.amendment_number,
        status: 'unknown' as const,
        ...(first
          ? {
              sponsor: {
                name: first.full_name,
                ...(first.member_id == null
                  ? {}
                  : { memberId: String(first.member_id) }),
              },
            }
          : {}),
        description: others.length
          ? `${label}. Also sponsored by ${others.map((o) => o.full_name).join(', ')}`
          : label,
        url: `${base}amendments/${a.amendment_number}/pdf/`,
      };
    },
  );

  const sponsored = new Map(
    ordered.map((r) => [`${r.formatted_version}_${r.version_id}`, r]),
  );
  // Sponsors can change between versions; the latest version's list is current.
  const latest = sponsored.get(versions.at(-1)?.code ?? '');
  return {
    history: BillHistory.parse({
      versions,
      actions,
      amendments,
      sources: (
        [
          ['', true],
          ['actions/', actionList],
          ['meetings/', meetingList],
          ['amendments/', amendmentList],
        ] as const
      ).flatMap(([path, part]) =>
        part ? [{ host: API_HOST, url: `${base}${path}`, fetchedAt }] : [],
      ),
    }),
    sponsorProfiles: [
      ...sponsorProfiles(latest?.sponsors ?? [], 'sponsor'),
      ...sponsorProfiles(latest?.cosponsors ?? [], 'cosponsor'),
    ],
    ...(actionList && meetingList && amendmentList ? {} : { partial: true }),
  };
}

export function chooseOhioVersion(history?: BillHistory): string {
  // Numeric prefixes give stage order, including same-day substitutes.
  const versions = history?.versions ?? [];
  const latest = [...versions].sort((a, b) => b.code.localeCompare(a.code))[0];
  if (!latest || versions.some((version) => !VERSION.test(version.code)))
    throw new AppError('FETCH_FAILED', undefined, {
      userMessage:
        'The Ohio record could not identify the latest text version. Paste a specific version URL from search-prod.lis.state.oh.us, such as one ending in /00_IN/pdf/.',
    });
  return latest.code;
}

export const ohioHistorySource: HistorySource = {
  source: 'ohio',
  hosts: [API_HOST],
  isVersion: (code) => VERSION.test(code),
  resolve: resolveOhio,
  read: async (plan, fetcher, now) => {
    const base = apiBase(plan as OhioPlan);
    // Only the bill endpoint is required. A failed optional part leaves that part out.
    const versions = await fetcher(base);
    const optional = async (path: string): Promise<Uint8Array | undefined> => {
      try {
        return (await fetcher(`${base}${path}`)).bytes;
      } catch {
        return undefined;
      }
    };
    return parseOhioHistory(
      {
        versions: versions.bytes,
        actions: await optional('actions/'),
        meetings: await optional('meetings/'),
        amendments: await optional('amendments/'),
      },
      plan as OhioPlan,
      now().toISOString(),
    );
  },
  textUrl: (plan, version) => ohioTextUrl(plan as OhioPlan, version),
};
