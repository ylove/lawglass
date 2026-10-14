import { load, type CheerioAPI } from 'cheerio';
import { AppError, BillHistory, SponsorProfile } from '../model/index.js';
import type { HistoryPlan, HistoryRecord, HistorySource } from './resolve.js';

const PAGE_HOST = 'www.legislature.ohio.gov';
const TEXT_HOST = 'search-prod.lis.state.oh.us';
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
  pageUrl: string;
}

/** Only identities and version codes enter constructed URLs, never page-provided URLs. */
export function ohioTextUrl(plan: OhioPlan, version: string): string {
  if (!VERSION.test(version)) throw new AppError('INVALID_INPUT');
  return `https://${TEXT_HOST}/api/v2/general_assembly_${plan.ga}/legislation/${plan.bill}/${version}/pdf/`;
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
    url.hostname === PAGE_HOST
      ? LANDING.exec(url.pathname)
      : url.hostname === TEXT_HOST
        ? TEXT.exec(url.pathname)
        : null;
  if (!match?.[1] || !match[2]) return undefined;
  const plan: OhioPlan = {
    source: 'ohio',
    ga: match[1],
    bill: match[2],
    pageUrl: `https://${PAGE_HOST}/legislation/${match[1]}/${match[2]}`,
  };
  if (match[3]) {
    plan.version = match[3];
    plan.textUrl = ohioTextUrl(plan, match[3]);
  }
  return plan;
}

const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** Ohio prints both M-D-YYYY and Month D, YYYY. Reject rollover dates. */
function date(value: string): string | undefined {
  const numeric = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(clean(value));
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const named = /^([A-Za-z]+) (\d{1,2}), (\d{4})$/.exec(clean(value));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const year = Number(numeric?.[3] ?? named?.[3] ?? iso?.[1]);
  const month = numeric
    ? Number(numeric[1])
    : named
      ? months.indexOf(named[1] ?? '') + 1
      : Number(iso?.[2]);
  const day = Number(numeric?.[2] ?? named?.[2] ?? iso?.[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
    ? parsed.toISOString().slice(0, 10)
    : undefined;
}

function page(html: string, plan: OhioPlan, kind: string): CheerioAPI {
  const $ = load(html);
  $('script,style,nav:not(.section-menu),header,footer').remove();
  const names: Readonly<Record<string, string>> = {
    hb: 'House Bill',
    sb: 'Senate Bill',
    hjr: 'House Joint Resolution',
    sjr: 'Senate Joint Resolution',
    hcr: 'House Concurrent Resolution',
    scr: 'Senate Concurrent Resolution',
    hr: 'House Resolution',
    sr: 'Senate Resolution',
  };
  const identity = /^([a-z]+)(\d+)$/.exec(plan.bill);
  const name = names[identity?.[1] ?? ''];
  const title = `${name ?? ''} ${identity?.[2] ?? ''}`;
  if (
    !clean($('.legislation h1').text()).startsWith(`${title} `) ||
    !$('.section-menu a')
      .toArray()
      .some(
        (anchor) =>
          $(anchor).attr('href') ===
          `/legislation/${plan.ga}/${plan.bill}/${kind}`,
      )
  )
    throw new AppError('PARSE_FAILED');
  return $;
}

function actions(
  $: CheerioAPI,
  selector: string,
  url: string,
): BillHistory['actions'] {
  return $(selector)
    .toArray()
    .map((row) => {
      const cells = $(row);
      const actionDate = date(cells.find('.date-cell').text());
      const committee =
        clean(cells.find('.committee-cell').text()) || undefined;
      // Ohio leaves some meeting statuses blank. The dated committee row still records a meeting.
      const text =
        clean(cells.find('.action-cell,.status-cell').text()) ||
        (cells.closest('table').hasClass('committee-meeting-table') && committee
          ? 'Committee meeting'
          : '');
      if (!actionDate || !text) throw new AppError('PARSE_FAILED');
      const heading = clean(
        cells.closest('table').prevAll('h2').first().text(),
      );
      const chamber =
        clean(cells.find('.chamber-cell').text()) ||
        (heading === 'House Committees'
          ? 'House'
          : heading === 'Senate Committees'
            ? 'Senate'
            : undefined);
      return {
        date: actionDate,
        text,
        chamber,
        committee,
        url,
      };
    });
}

function sponsors($: CheerioAPI): SponsorProfile[] {
  const profiles: SponsorProfile[] = [];
  for (const [selector, role] of [
    ['.legislation-primary-sponsors', 'sponsor'],
    ['.legislation-cosponsors', 'cosponsor'],
  ] as const) {
    $(selector)
      .find(
        'a[href], .other-primary-sponsors span, .legislation-cosponsors-inner > div > span',
      )
      .each((_, element) => {
        const node = $(element);
        const name = clean(node.attr('aria-label') ?? node.text());
        if (!name) return;
        let memberId: string | undefined;
        let chamber: SponsorProfile['chamber'];
        const links: SponsorProfile['links'] = [];
        try {
          const url = new URL(node.attr('href') ?? '', `https://${PAGE_HOST}`);
          const member = /^\/members\/([a-z0-9-]+)\/?$/.exec(url.pathname);
          if (
            url.protocol === 'https:' &&
            !url.port &&
            !url.username &&
            !url.password &&
            member?.[1] &&
            [
              'ohiohouse.gov',
              'www.ohiohouse.gov',
              'ohiosenate.gov',
              'www.ohiosenate.gov',
            ].includes(url.hostname)
          ) {
            memberId = member[1];
            chamber = url.hostname.includes('ohiohouse') ? 'house' : 'senate';
            links.push({
              kind: 'legislature',
              url: url.href,
              label: 'Ohio legislature member page',
              verified: true,
            });
          }
        } catch {
          /* Invalid member anchors retain only the stated name. */
        }
        const group = clean(
          node
            .closest('.legislation-cosponsors-inner')
            .find('.legislation-cosponsors-header')
            .text(),
        );
        chamber ??=
          group === 'Representatives'
            ? 'house'
            : group === 'Senators'
              ? 'senate'
              : undefined;
        profiles.push(
          SponsorProfile.parse({ name, role, memberId, chamber, links }),
        );
      });
  }
  return profiles;
}

/** Match a version to its stated stage, not an effective date or a later override vote. */
function versionDate(
  code: string,
  plan: OhioPlan,
  status: BillHistory['actions'],
): string | undefined {
  const stage = code.slice(3);
  const chamber =
    stage === 'IN'
      ? plan.bill.startsWith('h')
        ? 'House'
        : 'Senate'
      : stage.endsWith('H')
        ? 'House'
        : stage.endsWith('S')
          ? 'Senate'
          : undefined;
  const patterns: Readonly<Record<string, RegExp>> = {
    IN: /^Introduced$/,
    RH: /^Reported(?: - Substitute)?$/,
    RS: /^Reported(?: - Substitute)?$/,
    PH: /^Passed$/,
    PS: /^Passed$/,
    CR: /^Conference report agreed to$/,
    EN: /^Sent To The Governor$/i,
  };
  const pattern = patterns[stage];
  return status
    .filter(
      (action) =>
        pattern?.test(action.text) && (!chamber || action.chamber === chamber),
    )
    .map((action) => action.date)
    .sort()[0];
}

export function parseOhioHistory(
  pages: { status: string; documents: string; committee: string },
  plan: OhioPlan,
  fetchedAt: string,
): HistoryRecord {
  const status = page(pages.status, plan, 'status');
  const documents = page(pages.documents, plan, 'documents');
  const committee = page(pages.committee, plan, 'committee');
  if (
    !status('.legislation-status-table').length ||
    !documents('.legislation-section')
      .toArray()
      .some(
        (section) =>
          clean(documents(section).children('h2').text()) ===
          'Legislation Text',
      ) ||
    !committee('.content-area-1 > h2').length
  )
    throw new AppError('PARSE_FAILED');
  const statusActions = actions(
    status,
    '.legislation-status-table tbody tr',
    `${plan.pageUrl}/status`,
  );
  if (!statusActions.length) throw new AppError('PARSE_FAILED');
  const versions: BillHistory['versions'] = [];
  const amendments: BillHistory['amendments'] = [];
  documents('.legislation-section a[href]').each((_, element) => {
    const anchor = documents(element);
    const labelNode = anchor.clone();
    labelNode.find('.file-format-icon').remove();
    const label = clean(labelNode.text());
    const section = anchor.closest('.legislation-section');
    const isText = clean(section.children('h2').text()) === 'Legislation Text';
    if (
      !isText &&
      (!/\bamendments?\b/i.test(label) ||
        /\bcompar(?:ison|e|ative)\b/i.test(label))
    )
      return;
    let url: URL;
    try {
      url = new URL(anchor.attr('href') ?? '', plan.pageUrl);
    } catch {
      throw new AppError('PARSE_FAILED');
    }
    if (
      url.protocol !== 'https:' ||
      url.port ||
      url.username ||
      url.password ||
      ![PAGE_HOST, TEXT_HOST].includes(url.hostname)
    )
      throw new AppError('PARSE_FAILED');
    const row = anchor.closest('li,tr');
    const listedDate = date(
      row.find('time').attr('datetime') ?? row.find('.date-cell').text(),
    );
    if (isText) {
      const linked = resolveOhio(url);
      if (
        !linked?.version ||
        linked.ga !== plan.ga ||
        linked.bill !== plan.bill ||
        !label
      )
        throw new AppError('PARSE_FAILED');
      if (!versions.some((version) => version.code === linked.version))
        versions.push({
          code: linked.version,
          label,
          date: listedDate ?? versionDate(linked.version, plan, statusActions),
          url: ohioTextUrl(plan, linked.version),
        });
    } else {
      amendments.push({
        id: `${url.pathname}${url.search}`
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, ''),
        status:
          /\bamendment\b.*\badopted\b/i.test(label) &&
          !/\bnot adopted\b/i.test(label)
            ? 'adopted'
            : 'unknown',
        description: label,
        date: listedDate,
        committee: clean(row.find('.committee-cell').text()) || undefined,
        url: url.href,
      });
    }
  });
  if (!versions.length) throw new AppError('PARSE_FAILED');
  return {
    history: BillHistory.parse({
      versions,
      actions: [
        ...statusActions,
        ...actions(
          committee,
          '.committee-meeting-table tbody tr',
          `${plan.pageUrl}/committee`,
        ),
      ],
      amendments,
      sources: ['status', 'documents', 'committee'].map((kind) => ({
        host: PAGE_HOST,
        url: `${plan.pageUrl}/${kind}`,
        fetchedAt,
      })),
    }),
    sponsorProfiles: sponsors(status),
  };
}

export function chooseOhioVersion(history?: BillHistory): string {
  // Documents are listed newest first. Numeric prefixes also order same-day substitutes.
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
  hosts: [PAGE_HOST, TEXT_HOST],
  isVersion: (code) => VERSION.test(code),
  resolve: resolveOhio,
  read: async (plan, fetcher, now) => {
    const ohio = plan as OhioPlan;
    const status = await fetcher(`${ohio.pageUrl}/status`);
    const documents = await fetcher(`${ohio.pageUrl}/documents`);
    const committee = await fetcher(`${ohio.pageUrl}/committee`);
    const decode = (bytes: Uint8Array) =>
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return parseOhioHistory(
      {
        status: decode(status.bytes),
        documents: decode(documents.bytes),
        committee: decode(committee.bytes),
      },
      ohio,
      now().toISOString(),
    );
  },
  textUrl: (plan, version) => ohioTextUrl(plan as OhioPlan, version),
};
