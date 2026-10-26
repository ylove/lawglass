/**
 * Public pages on the official site that hold the full record behind a bill's history card
 * ("See all 49 actions"). Built only from identities we validate ourselves (congress, bill
 * type and number, Ohio assembly and bill code) and fixed official hosts: nothing from a
 * record or a page is ever copied into a link.
 */
import type { BillHistory } from '../model/index.js';
import { ordinal } from '../parse/xml.js';
import { OHIO_BILL } from './ohio-legislature.js';
import { BILL_TYPES, resolveGovinfo } from './resolve.js';

export interface HistoryLinks {
  actions?: string;
  amendments?: string;
}

const SLUG_BY_TYPE = new Map(
  Object.entries(BILL_TYPES).map(([slug, type]) => [type, slug]),
);
const OHIO_API_HOST = 'search-prod.lis.state.oh.us';
const OHIO_API_PATH = new RegExp(
  `^/api/v2/general_assembly_([1-9][0-9]{0,2})/legislation/(${OHIO_BILL})(?:/|$)`,
);
const OHIO_LANDING_PATH = new RegExp(
  `^/legislation/([1-9][0-9]{0,2})/(${OHIO_BILL})(?:/|$)`,
);

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function federalLinks(candidates: readonly URL[]): HistoryLinks | undefined {
  for (const url of candidates) {
    let plan: ReturnType<typeof resolveGovinfo>;
    try {
      plan = resolveGovinfo(url);
    } catch {
      continue; // A Congress.gov URL that is not a bill page: try the next candidate.
    }
    const slug = plan ? SLUG_BY_TYPE.get(plan.type) : undefined;
    if (!plan || !slug) continue;
    const base = `https://www.congress.gov/bill/${ordinal(plan.congress)}-congress/${slug}/${String(plan.number)}`;
    return { actions: `${base}/all-actions`, amendments: `${base}/amendments` };
  }
  return undefined;
}

/**
 * Ohio's public bill pages are single-page apps; only the status tab was confirmed to exist
 * for every bill (it lists the actions). The amendments are inside the Documents tab, which
 * we could not confirm lists them, so no amendments link is offered.
 */
function ohioLinks(candidates: readonly URL[]): HistoryLinks | undefined {
  for (const url of candidates) {
    if (url.protocol !== 'https:' || url.port || url.username || url.password)
      continue;
    const match =
      url.hostname === OHIO_API_HOST
        ? OHIO_API_PATH.exec(url.pathname)
        : url.hostname === 'www.legislature.ohio.gov'
          ? OHIO_LANDING_PATH.exec(url.pathname)
          : null;
    if (match?.[1] && match[2])
      return {
        actions: `https://www.legislature.ohio.gov/legislation/${match[1]}/${match[2]}/status`,
      };
  }
  return undefined;
}

/** Empty when the source is not a federal or Ohio bill we recognise (e.g. New York, New Jersey). */
export function historyLinksFor(
  sourceUrl: string,
  history: BillHistory | undefined,
): HistoryLinks {
  // The history's own source is the most exact identity; the document URL covers the rest.
  const candidates = [
    ...(history?.sources ?? []).map((s) => parseUrl(s.url)),
    parseUrl(sourceUrl),
  ].filter((u): u is URL => u !== undefined);
  return federalLinks(candidates) ?? ohioLinks(candidates) ?? {};
}
