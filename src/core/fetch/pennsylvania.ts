import { AppError } from '../model/index.js';

/** Exact hosts only: a suffix check would also accept a lookalike such as `evilpalegis.us`. */
const SITE_HOSTS: ReadonlySet<string> = new Set([
  'palegis.us',
  'www.palegis.us',
]);
/**
 * The legislature's older site. Its bill links still circulate and redirect to palegis.us; they
 * are accepted as pasted input and mapped, never fetched.
 */
const OLD_HOSTS: ReadonlySet<string> = new Set([
  'legis.state.pa.us',
  'www.legis.state.pa.us',
]);
export const PENNSYLVANIA_HOSTS: readonly string[] = [
  ...SITE_HOSTS,
  ...OLD_HOSTS,
];
/** The bare host redirects here; every URL this module builds uses it. */
const CANONICAL_HOST = 'www.palegis.us';

/** HB/SB are bills (a constitutional amendment is a "joint resolution" numbered as a bill). */
const TYPES = ['HB', 'SB', 'HR', 'SR'] as const;
type BillType = (typeof TYPES)[number];

export interface PennsylvaniaLookup {
  /** First year of the two-year session (2025 for 2025-2026). */
  year: number;
  /** 0 for the regular session, 1 to 3 for a special session. */
  session: number;
  type: BillType;
  /** Bill number without padding. */
  number: number;
}
export interface PennsylvaniaResolution {
  /** Known text URL (a pasted printer's number). Absent when a lookup is needed. */
  textUrl?: string;
  /** Present for a bill page: read the page's own list of printer's numbers. */
  lookup?: PennsylvaniaLookup;
}

function billUrlError(message?: string): AppError {
  return new AppError('INVALID_INPUT', undefined, {
    userMessage:
      message ??
      'Paste a Pennsylvania bill or resolution page (palegis.us/legislation/bills/2025/hb2443) or a palegis.us bill text link.',
  });
}

function checkYear(year: string): number {
  const value = Number(year);
  if (!/^\d{4}$/.test(year) || value < 1971 || value > 2100)
    throw billUrlError();
  return value;
}

function billType(code: string): BillType {
  const upper = code.toUpperCase();
  const type = TYPES.find((candidate) => candidate === upper);
  if (!type) throw billUrlError();
  return type;
}

/** The site's page URL for a bill; the numbers carry no padding there. */
export function pennsylvaniaPageUrl(lookup: PennsylvaniaLookup): string {
  const session = lookup.session === 0 ? '' : `${String(lookup.session)}/`;
  return `https://${CANONICAL_HOST}/legislation/bills/${String(lookup.year)}/${session}${lookup.type.toLowerCase()}${String(lookup.number)}`;
}

/**
 * The PDF of one printer's number. Text paths are zero-padded to four digits ("SR0374",
 * "PN0613"); the unpadded form is a 404.
 */
function textUrlFor(lookup: PennsylvaniaLookup, printer: number): string {
  const pad = (value: number): string => String(value).padStart(4, '0');
  return `https://${CANONICAL_HOST}/legislation/bills/text/PDF/${String(lookup.year)}/${String(lookup.session)}/${lookup.type}${pad(lookup.number)}/PN${pad(printer)}`;
}

function sessionIndex(value: string | undefined): number {
  const index = Number(value ?? '0');
  if (!/^[0-3]$/.test(value ?? '0')) throw billUrlError();
  return index;
}

function plainUrl(url: URL, input: string): void {
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    /\\|\/(?:\.|\.\.)\//.test(input) ||
    url.pathname.includes('%')
  )
    throw billUrlError();
}

function badPrinter(): AppError {
  return billUrlError(
    "That Pennsylvania link's printer's number (pn) is not a positive whole number.",
  );
}

function notBillText(): AppError {
  return billUrlError(
    'That Pennsylvania link is a fiscal note, memo or other document, not bill text. Paste the bill page or a printer-number bill text link.',
  );
}

/** The older site's query-string links: btCheck.cfm is text, billinfo.cfm is a bill page. */
function resolveOld(url: URL): PennsylvaniaResolution {
  // newSiteRedirect.cfm?targetPage=... wraps the real old path and its parameters.
  const params = url.searchParams;
  let path = url.pathname.toLowerCase();
  if (path === '/newsiteredirect.cfm')
    path = `/${(params.get('targetPage') ?? '').toLowerCase()}`;

  const isText = path === '/cfdocs/legis/pn/public/btcheck.cfm';
  if (isText || path === '/cfdocs/billinfo/billinfo.cfm') {
    // The two pages name the same facts differently.
    const names = isText
      ? {
          body: 'billBody',
          kind: 'billTyp',
          bill: 'billNbr',
          year: 'sessYr',
          ind: 'sessInd',
        }
      : { body: 'body', kind: 'type', bill: 'bn', year: 'syear', ind: 'sind' };
    const body = (params.get(names.body) ?? '').toUpperCase();
    const kind = (params.get(names.kind) ?? '').toUpperCase();
    const bill = params.get(names.bill) ?? '';
    if (!/^[HS]$/.test(body) || !/^[BR]$/.test(kind) || !/^\d{1,4}$/.test(bill))
      throw billUrlError();
    const lookup: PennsylvaniaLookup = {
      year: checkYear(params.get(names.year) ?? ''),
      session: sessionIndex(params.get(names.ind) ?? undefined),
      type: billType(`${body}${kind}`),
      number: Number(bill),
    };
    if (lookup.number < 1) throw billUrlError();
    if (!isText) return { lookup };
    // The latest print is used only when no printer's number is given; a given one must be real.
    const pn = params.get('pn');
    if (pn === null || pn === '') return { lookup };
    if (!/^[1-9]\d{0,4}$/.test(pn)) throw badPrinter();
    return { textUrl: textUrlFor(lookup, Number(pn)) };
  }

  // Direct files: /WU01/LI/BI/BT/2025/0/HB2443P4082.pdf (bill text). FN/SFN/etc. are not text.
  const file =
    /^\/wu01\/li\/bi\/([a-z]{2,3})\/(\d{4})\/(\d)\/([a-z]{2})(\d{1,4})p(\d{1,5})\.(?:pdf|htm|doc)$/.exec(
      path,
    );
  if (file) {
    if (file[1] !== 'bt') throw notBillText();
    const lookup: PennsylvaniaLookup = {
      year: checkYear(file[2] ?? ''),
      session: sessionIndex(file[3]),
      type: billType(file[4] ?? ''),
      number: Number(file[5]),
    };
    if (lookup.number < 1) throw billUrlError();
    if (!/^0*[1-9]\d{0,4}$/.test(file[6] ?? '')) throw badPrinter();
    return { textUrl: textUrlFor(lookup, Number(file[6])) };
  }
  throw billUrlError();
}

/**
 * Anchored mapping with no scraped links. A bill page names its newest printer's number through
 * the page itself (see `choosePennsylvaniaText`); a link that names a printer's number keeps it.
 * HTML and Word text links map to the PDF twin, because the HTML export is a page-by-page
 * absolute-positioned layout that loses the underline and strike-through marks.
 * Unsupported PA routes fail before any fetch; non-PA hosts return undefined.
 */
export function resolvePennsylvania(
  input: string,
): PennsylvaniaResolution | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const old = OLD_HOSTS.has(url.hostname);
  if (!old && !SITE_HOSTS.has(url.hostname)) return undefined;
  plainUrl(url, input);
  if (old) return resolveOld(url);

  // Bill page: /legislation/bills/2025/hb2443, or /2023/1/hb1 for a special session.
  const page =
    /^\/legislation\/bills\/(\d{4})\/(?:([0-3])\/)?([a-z]{2})0*([1-9]\d{0,3})\/?$/i.exec(
      url.pathname,
    );
  if (page)
    return {
      lookup: {
        year: checkYear(page[1] ?? ''),
        session: sessionIndex(page[2]),
        type: billType(page[3] ?? ''),
        number: Number(page[4]),
      },
    };

  // Bill text: /legislation/bills/text/PDF|HTM|DOC/2025/0/HB2443/PN4082, in any letter case.
  const text =
    /^\/legislation\/bills\/text\/(?:pdf|htm|doc)\/(\d{4})\/([0-3])\/([a-z]{2})0*([1-9]\d{0,3})\/pn0*([1-9]\d{0,4})\/?$/i.exec(
      url.pathname,
    );
  if (text) {
    const lookup: PennsylvaniaLookup = {
      year: checkYear(text[1] ?? ''),
      session: sessionIndex(text[2]),
      type: billType(text[3] ?? ''),
      number: Number(text[4]),
    };
    return { textUrl: textUrlFor(lookup, Number(text[5])) };
  }
  // The fiscal note and sponsor memo files sit beside the text and carry no change marks.
  if (/^\/wu01\/li\/bi\/(?:fn|sfn|co)\//i.test(url.pathname))
    throw notBillText();
  throw billUrlError();
}

/**
 * The newest printer's number on a bill page. The page is server-rendered and lists every
 * printer's number as a link to its text; the highest number is the newest print. Only links
 * for this exact bill count, so another bill's link in a sidebar cannot be chosen.
 */
export function choosePennsylvaniaText(
  html: string,
  lookup: PennsylvaniaLookup,
): string {
  const link =
    /\/legislation\/bills\/text\/PDF\/(\d{4})\/(\d)\/([A-Z]{2})(\d{4})\/PN(\d{4,5})(?!\d)/gi;
  let best = 0;
  for (const match of html.matchAll(link)) {
    if (
      Number(match[1]) !== lookup.year ||
      Number(match[2]) !== lookup.session ||
      (match[3] ?? '').toUpperCase() !== lookup.type ||
      Number(match[4]) !== lookup.number
    )
      continue;
    best = Math.max(best, Number(match[5]));
  }
  if (best === 0)
    throw billUrlError(
      `${lookup.type} ${String(lookup.number)} has no published bill text in the ${String(lookup.year)} session yet.`,
    );
  return textUrlFor(lookup, best);
}

/** safeFetch invokes this on every redirect as well as on the final URL. */
export function assertPennsylvaniaFetch(
  url: URL,
  /** True only for the bill-page lookup, whose missing page redirects to /404. */
  allowNotFound = false,
): void {
  const allowed =
    SITE_HOSTS.has(url.hostname) &&
    (/^\/legislation\/bills\/\d{4}\/(?:[0-3]\/)?[a-z]{2}\d{1,4}\/?$/i.test(
      url.pathname,
    ) ||
      /^\/legislation\/bills\/text\/PDF\/\d{4}\/[0-3]\/[A-Z]{2}\d{4}\/PN\d{4,5}$/i.test(
        url.pathname,
      ) ||
      // A page that does not exist redirects here; the lookup then reports "no text".
      (allowNotFound && url.pathname === '/404'));
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !allowed
  )
    throw new AppError(
      'SSRF_BLOCKED',
      'The Pennsylvania full-text source address is not allowed.',
    );
}
