import { z } from 'zod';
import { AppError, BillHistory, SponsorProfile } from '../model/index.js';
import type { HistoryPlan, HistoryRecord, HistorySource } from './resolve.js';

/**
 * Ohio history comes from the legislature's own LIS JSON API. We never fetch
 * www.legislature.ohio.gov: it serves the wrong intermediate certificate, so Node
 * cannot verify it, and we will not weaken TLS. Its bill URLs are only recognised
 * and mapped to the API.
 *
 * Every string returned here comes from a remote record. Consumers must render it
 * as text, never as HTML. Tags are stripped on the way in as a second line of defence.
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

/** Drop markup and control characters. Entities are decoded first so none can hide a tag. */
export function plainText(value: string): string {
  const entities: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  const decoded = value.replace(
    /&(#\d{1,6}|#x[0-9a-f]{1,5}|[a-z]+);/gi,
    (m, e) => {
      const name = String(e);
      if (name.startsWith('#')) {
        const code =
          name[1]?.toLowerCase() === 'x'
            ? parseInt(name.slice(2), 16)
            : parseInt(name.slice(1), 10);
        return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
      }
      return entities[name.toLowerCase()] ?? m;
    },
  );
  return decoded
    .replace(
      /<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>/gi,
      ' ',
    )
    .replace(/<[^>]*>?/g, ' ')
    .replace(/[<>]/g, ' ')

    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const Text = z.string().transform(plainText);
const OptionalText = Text.nullish().transform((v) =>
  v?.length ? v : undefined,
);
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}/);

const Member = z.object({
  full_name: Text.pipe(z.string().min(1)),
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
});
const VersionList = z.array(VersionRecord).min(1);
const ActionList = z.array(ActionRecord);
const MeetingList = z.array(MeetingRecord);
const AmendmentList = z.array(AmendmentRecord);

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
    actions: Uint8Array;
    meetings: Uint8Array;
    amendments: Uint8Array;
  },
  plan: OhioPlan,
  fetchedAt: string,
): HistoryRecord {
  const records = json(VersionList, responses.versions);
  if (records.some((r) => r.number && r.number !== plan.bill))
    throw new AppError('PARSE_FAILED');
  const base = apiBase(plan);
  // Stage order is the numeric prefix (00 introduced ... enrolled last).
  const ordered = [...records].sort((a, b) =>
    `${a.formatted_version}_${a.version_id}`.localeCompare(
      `${b.formatted_version}_${b.version_id}`,
    ),
  );
  const versions: BillHistory['versions'] = ordered.map((r) => {
    const code = `${r.formatted_version}_${r.version_id}`;
    return { code, label: r.version, url: ohioTextUrl(plan, code) };
  });

  const actions: BillHistory['actions'] = [
    ...json(ActionList, responses.actions).map((a) => ({
      date: day(a.occurred),
      text: a.action,
      chamber: a.chamber,
      committee: a.cmte_name ?? a.committee,
      url: `${base}actions/`,
    })),
    ...json(MeetingList, responses.meetings)
      .filter((m) => !m.canceled)
      .map((m) => ({
        date: day(m.meeting_date),
        text: `Heard in ${m.committee}`,
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

  // The record lists amendment numbers and the version they amend. Nothing else is stated
  // that we can attribute (no date or committee), so nothing else is claimed.
  const amendments: BillHistory['amendments'] = json(
    AmendmentList,
    responses.amendments,
  ).map((a) => ({
    id: a.amendment_number,
    number: a.amendment_number,
    status: 'unknown' as const,
    description: a.version
      ? `Amendment ${a.amendment_number} (${a.version})`
      : `Amendment ${a.amendment_number}`,
    url: `${base}amendments/${a.amendment_number}/pdf/`,
  }));

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
      sources: ['', 'actions/', 'meetings/', 'amendments/'].map((path) => ({
        host: API_HOST,
        url: `${base}${path}`,
        fetchedAt,
      })),
    }),
    sponsorProfiles: [
      ...sponsorProfiles(latest?.sponsors ?? [], 'sponsor'),
      ...sponsorProfiles(latest?.cosponsors ?? [], 'cosponsor'),
    ],
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
    const versions = await fetcher(base);
    const actions = await fetcher(`${base}actions/`);
    const meetings = await fetcher(`${base}meetings/`);
    const amendments = await fetcher(`${base}amendments/`);
    return parseOhioHistory(
      {
        versions: versions.bytes,
        actions: actions.bytes,
        meetings: meetings.bytes,
        amendments: amendments.bytes,
      },
      plan as OhioPlan,
      now().toISOString(),
    );
  },
  textUrl: (plan, version) => ohioTextUrl(plan as OhioPlan, version),
};
