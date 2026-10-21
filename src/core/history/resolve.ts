import {
  AppError,
  type BillHistory,
  type SponsorProfile,
} from '../model/index.js';
import {
  chooseOhioVersion,
  isOhioLandingHost,
  ohioHistorySource,
  ohioPageError,
} from './ohio-legislature.js';
import { parseGovinfoBillStatus } from './govinfo-billstatus.js';
import type { SafeFetchResult } from '../fetch/index.js';
import { trimEndWhile } from '../trim.js';

/** Internal adapter seam, deliberately separate from the frozen document contracts. */
export interface HistoryPlan {
  source: string;
  version?: string;
  textUrl?: string;
}
export interface HistoryRecord {
  history: BillHistory;
  sponsorProfiles: SponsorProfile[];
  /** The record's official title (federal only), for the preview. Stored beside the history. */
  officialTitle?: string;
  /** Part of the record could not be read; the rest is kept and the user is warned. */
  partial?: boolean;
}
export interface HistorySource {
  source: string;
  hosts: readonly string[];
  isVersion: (code: string) => boolean;
  resolve: (url: URL) => HistoryPlan | undefined;
  read: (
    plan: HistoryPlan,
    fetcher: (url: string) => Promise<SafeFetchResult>,
    now: () => Date,
  ) => Promise<HistoryRecord>;
  textUrl: (plan: HistoryPlan, version: string) => string;
}
export interface GovinfoPlan extends HistoryPlan {
  source: 'govinfo';
  billStatusUrl: string;
  congress: number;
  type: string;
  number: number;
}

const BILL_TYPES: Readonly<Record<string, string>> = {
  'house-bill': 'hr',
  'senate-bill': 's',
  'house-joint-resolution': 'hjres',
  'senate-joint-resolution': 'sjres',
  'house-concurrent-resolution': 'hconres',
  'senate-concurrent-resolution': 'sconres',
  'house-resolution': 'hres',
  'senate-resolution': 'sres',
};
export const VERSION_CODE = /^[a-z]{1,8}[0-9]?$/;
const TYPES = 'hr|s|hjres|sjres|hconres|sconres|hres|sres';
const PACKAGE = new RegExp(
  `^BILLS-([1-9][0-9]{0,2})(${TYPES})([1-9][0-9]{0,5})([a-z]{1,8}[0-9]?)$`,
);
const STATUS = new RegExp(
  `^/bulkdata/BILLSTATUS/([1-9][0-9]{0,2})/(${TYPES})/BILLSTATUS-([1-9][0-9]{0,2})(${TYPES})([1-9][0-9]{0,5})\\.xml$`,
);

function billPageError(): AppError {
  return new AppError('INVALID_INPUT', undefined, {
    userMessage:
      'Paste a congress.gov bill URL such as /bill/118th-congress/house-bill/5009, optionally followed by /text/ih.',
  });
}

function isCongressHost(url: URL): boolean {
  const host = trimEndWhile(url.hostname, (c) => c === '.');
  return host === 'congress.gov' || host.endsWith('.congress.gov');
}

/** Also covers a redirect to Congress.gov from an otherwise ordinary document URL. */
export function assertNoCongressFetch(url: URL): void {
  if (isCongressHost(url)) throw billPageError();
  if (isOhioLandingHost(url)) throw ohioPageError();
}

export function govinfoTextUrl(plan: GovinfoPlan, version: string): string {
  if (!VERSION_CODE.test(version)) throw new AppError('INVALID_INPUT');
  const pkg = `BILLS-${String(plan.congress)}${plan.type}${String(plan.number)}${version}`;
  return `https://www.govinfo.gov/content/pkg/${pkg}/xml/${pkg}.xml`;
}

function planFor(
  congress: string,
  type: string,
  number: string,
  version?: string,
): GovinfoPlan {
  const plan: GovinfoPlan = {
    source: 'govinfo',
    congress: Number(congress),
    type,
    number: Number(number),
    billStatusUrl: `https://www.govinfo.gov/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}${type}${number}.xml`,
  };
  if (version) {
    plan.version = version;
    plan.textUrl = govinfoTextUrl(plan, version);
  }
  return plan;
}

/** Anchored mapping only: no page reads, decoded paths, or arbitrary package suffixes. */
export function resolveGovinfo(url: URL): GovinfoPlan | undefined {
  const congressHost =
    url.hostname === 'www.congress.gov' || url.hostname === 'congress.gov';
  if (
    !congressHost &&
    url.hostname !== 'www.govinfo.gov' &&
    url.hostname !== 'govinfo.gov'
  )
    return undefined;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    /(?:%|\\|\/\.\.?\/)/.test(url.pathname)
  ) {
    if (congressHost) throw billPageError();
    return undefined;
  }
  if (congressHost) {
    const match =
      /^\/bill\/([1-9][0-9]{0,2})(?:st|nd|rd|th)-congress\/([a-z-]+)\/([1-9][0-9]{0,5})(?:\/text(?:\/([a-z]{1,8}[0-9]?))?)?\/?$/.exec(
        url.pathname,
      );
    const type = match?.[2] ? BILL_TYPES[match[2]] : undefined;
    const congress = match?.[1];
    const number = match?.[3];
    if (!congress || !number || !type) throw billPageError();
    return planFor(congress, type, number, match[4]);
  }
  const status = STATUS.exec(url.pathname);
  if (
    status?.[1] &&
    status[2] &&
    status[5] &&
    status[1] === status[3] &&
    status[2] === status[4]
  )
    return planFor(status[1], status[2], status[5]);
  const path =
    /^\/(?:app\/details\/([^/]+)|content\/pkg\/([^/]+)\/(xml|pdf|html)\/([^/]+))\/?$/.exec(
      url.pathname,
    );
  const pkg = path?.[1] ?? path?.[2];
  const match = pkg ? PACKAGE.exec(pkg) : null;
  const congress = match?.[1];
  const type = match?.[2];
  const number = match?.[3];
  if (!path || !pkg || !congress || !type || !number) return undefined;
  const extension = path[3] === 'html' ? 'htm' : path[3];
  if (path[2] && path[4] !== `${pkg}.${extension ?? ''}`) return undefined;
  return planFor(congress, type, number, match[4]);
}

// Adding another jurisdiction requires one adapter file and one registration here.
export const HISTORY_SOURCES: readonly HistorySource[] = [
  ohioHistorySource,
  {
    source: 'govinfo',
    hosts: ['www.govinfo.gov'],
    isVersion: (code) => VERSION_CODE.test(code),
    resolve: resolveGovinfo,
    read: async (plan, fetcher, now) => {
      const federal = plan as GovinfoPlan;
      const status = await fetcher(federal.billStatusUrl);
      return parseGovinfoBillStatus(status.bytes, federal, now().toISOString());
    },
    textUrl: (plan, version) => govinfoTextUrl(plan as GovinfoPlan, version),
  },
];

export function historySource(source: string): HistorySource {
  const adapter = HISTORY_SOURCES.find((item) => item.source === source);
  if (!adapter) throw new AppError('INVALID_INPUT');
  return adapter;
}

export function resolveHistory(input: string): HistoryPlan | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (
    isCongressHost(url) &&
    !['congress.gov', 'www.congress.gov'].includes(url.hostname)
  )
    throw billPageError();
  // URL normalizes dot segments and backslashes. Reject them in the original input too.
  if (
    /\\|\/(?:\.|\.\.)\//.test(input) &&
    ['congress.gov', 'www.congress.gov'].includes(url.hostname)
  )
    throw billPageError();
  for (const source of HISTORY_SOURCES) {
    // Preserve the anchored mapping when URL has normalized a raw dot segment or backslash.
    if (source.source === 'ohio' && /\\|\/(?:\.|\.\.)\//.test(input)) continue;
    const plan = source.resolve(url);
    if (plan) return plan;
  }
  // The landing host fails TLS from Node and is never fetched; say what to paste instead.
  if (isOhioLandingHost(url)) throw ohioPageError();
  return undefined;
}

export function chooseVersion(
  plan: HistoryPlan,
  history?: BillHistory,
): string {
  if (plan.version) return plan.version;
  if (plan.source === 'ohio') return chooseOhioVersion(history);
  const versions = history?.versions ?? [];
  // Stored versions are oldest first; GovInfo lists them newest first, and that order is
  // authoritative, including equal or missing dates (Enrolled often has <date/>). Dates
  // never override it.
  // The newest stored entry decides. If its link was unusable (empty code) we fail instead
  // of falling back to an older text.
  const latest = versions.at(-1);
  if (!latest || !historySource(plan.source).isVersion(latest.code)) {
    throw new AppError('FETCH_FAILED', undefined, {
      userMessage:
        'The official record could not identify the latest text version. Paste a specific version URL, such as a congress.gov bill URL ending in /text/ih or a GovInfo BILLS version URL.',
    });
  }
  return latest.code;
}
