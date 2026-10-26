import { z } from 'zod';
import { AppError } from '../model/index.js';

/** Exact hosts only: a suffix check would also accept a lookalike such as `evilnjleg.gov`. */
const LANDING_HOSTS: ReadonlySet<string> = new Set([
  'njleg.state.nj.us',
  'www.njleg.state.nj.us',
  'njleg.gov',
  'www.njleg.gov',
]);
export const NJ_TEXT_HOSTS: ReadonlySet<string> = new Set([
  'pub.njleg.gov',
  'pub.njleg.state.nj.us',
]);
/** The legislature's own keyless JSON that the bill page itself reads. */
const API_HOST = 'www.njleg.state.nj.us';
const TEXT_HOST = 'pub.njleg.gov';
export const NEW_JERSEY_HOSTS: readonly string[] = [
  ...LANDING_HOSTS,
  ...NJ_TEXT_HOSTS,
];

export interface NewJerseyLookup {
  /** First year of the two-year session (2024 for 2024-2025). */
  session: number;
  /** "S1000" or "A3000". */
  bill: string;
}
export interface NewJerseyResolution {
  /** Known text URL (an explicitly named version). Absent when a lookup is needed. */
  textUrl?: string;
  /** Present for a bill page: ask the legislature's JSON for the newest bill text. */
  lookup?: NewJerseyLookup;
}

function billUrlError(message?: string): AppError {
  return new AppError('INVALID_INPUT', undefined, {
    userMessage:
      message ??
      'Paste a New Jersey bill page (njleg.state.nj.us/bill-search/2026/S1000) or a pub.njleg.gov/Bills/... bill text link.',
  });
}

/** Version files that are bill text: introduced (I1), technical review (T1) and reprints (R1, R2, ...). */
const TEXT_VERSION = /^(\d{1,5})_([IRT]\d{1,2})$/i;
const FOLDER = /^[SA]\d{4}$/i;

function sessionStart(year: string): number {
  const value = Number(year);
  if (!/^\d{4}$/.test(year) || value < 1996 || value > 2100)
    throw billUrlError();
  return value - (value % 2);
}

function textUrlFor(
  year: number,
  folder: string,
  version: string,
  fileName: string,
): string {
  // The PDF carries the "EXPLANATION" legend that makes bracketed words safe to read as
  // deletions; the HTML export does not, so every version is read from its PDF twin.
  return `https://${TEXT_HOST}/Bills/${String(year)}/${folder.toUpperCase()}/${fileName}_${version.toUpperCase()}.PDF`;
}

function versionError(): AppError {
  return billUrlError(
    'That New Jersey link is a statement, fiscal estimate, veto or enacted-law copy, not bill text. Paste the bill page, or an _I1 / _T1 / _R1 bill text link.',
  );
}

/**
 * Anchored mapping with no scraped links. A bill page asks the legislature's JSON for the
 * newest introduced, technical-review or reprint text; a link that names a version keeps that version.
 * Unsupported NJ routes fail before any fetch; non-NJ hosts return undefined.
 */
export function resolveNewJersey(
  input: string,
): NewJerseyResolution | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  const textHost = NJ_TEXT_HOSTS.has(url.hostname);
  if (!textHost && !LANDING_HOSTS.has(url.hostname)) return undefined;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    /\\|\/(?:\.|\.\.)\//.test(input) ||
    url.pathname.includes('%')
  )
    throw billUrlError();

  // Bill page, with or without the "bill-text" tab and its f=/n= version parameters.
  const page =
    /^\/bill-search\/(\d{4})\/([SA])0*([1-9]\d{0,4})(\/bill-text)?\/?$/i.exec(
      url.pathname,
    );
  if (page && !textHost) {
    const session = sessionStart(page[1] ?? '');
    const bill = `${(page[2] ?? '').toUpperCase()}${page[3] ?? ''}`;
    const named = url.searchParams.get('n');
    if (!page[4] || !named) return { lookup: { session, bill } };
    const folder = url.searchParams.get('f') ?? '';
    const match = TEXT_VERSION.exec(named);
    if (!match || !FOLDER.test(folder)) throw versionError();
    // A bill's folder always carries its own house letter (S1500 holds Senate bills).
    if (folder.charAt(0).toUpperCase() !== bill.charAt(0)) throw billUrlError();
    if (match[1] !== page[3]) throw billUrlError();
    return {
      textUrl: textUrlFor(session, folder, match[2] ?? '', match[1] ?? ''),
    };
  }

  // pub.njleg.gov/Bills/<year>/<folder>/<n>_<version>.HTM|PDF, and the older
  // njleg.state.nj.us/<year>/Bills/<folder>/... form. The path's case varies by host.
  const file =
    /^\/(?:bills\/(\d{4})|(\d{4})\/bills)\/([SA]\d{4})\/(\d{1,5})_([A-Z]\d{0,2})?\.(?:htm|pdf)$/i.exec(
      url.pathname,
    );
  if (file) {
    const version = `${file[4] ?? ''}_${file[5] ?? ''}`;
    const match = TEXT_VERSION.exec(version);
    if (!match) throw versionError();
    return {
      textUrl: textUrlFor(
        sessionStart(file[1] ?? file[2] ?? ''),
        file[3] ?? '',
        match[2] ?? '',
        match[1] ?? '',
      ),
    };
  }
  throw billUrlError();
}

const BillTextRows = z.array(
  z
    .object({
      Description: z.string().optional(),
      HTML_Link: z.string().optional(),
      PDFLink: z.string().optional(),
    })
    .loose(),
);
/** Bill text only; Statement, Fiscal Estimate, Veto and law copies carry no change marks. */
const LINK =
  /^\/Bills\/(\d{4})\/([SA]\d{4})\/(\d{1,5})_(([IRT])(\d{1,2}))\.(?:HTM|PDF)$/i;

export function newJerseyLookupUrl(lookup: NewJerseyLookup): string {
  return `https://${API_HOST}/api/billDetailHist/billText/${lookup.bill}/${String(lookup.session)}`;
}

/** Pure choice of the newest bill-text version from the legislature's JSON. */
export function chooseNewJerseyText(
  json: unknown,
  lookup: NewJerseyLookup,
): string {
  const rows = BillTextRows.safeParse(json);
  if (!rows.success) throw new AppError('FETCH_FAILED');
  let best: { rank: number; url: string } | undefined;
  for (const row of rows.data) {
    const link = row.PDFLink ?? row.HTML_Link ?? '';
    const match = LINK.exec(link);
    if (!match || Number(match[1]) !== lookup.session) continue;
    // The folder differs from the bill number in places (S100 lives in S0500).
    if ((match[3] ?? '') !== lookup.bill.slice(1)) continue;
    // A house-letter mismatch (A1500 for S1446) is another bill's file.
    if ((match[2] ?? '').charAt(0).toUpperCase() !== lookup.bill.charAt(0))
      continue;
    // Introduced < technical review of the prefiled bill < committee reprints.
    const kind = match[5]?.toUpperCase();
    const rank = kind === 'I' ? 0 : kind === 'T' ? 0.5 : Number(match[6]);
    if (!best || rank >= best.rank)
      best = {
        rank,
        url: textUrlFor(
          lookup.session,
          match[2] ?? '',
          match[4] ?? '',
          match[3] ?? '',
        ),
      };
  }
  if (!best)
    throw billUrlError(
      `${lookup.bill} has no published bill text in the ${String(lookup.session)} session yet.`,
    );
  return best.url;
}

/** safeFetch invokes this on every redirect as well as on the final URL. */
export function assertNewJerseyFetch(url: URL): void {
  const api =
    url.hostname === API_HOST &&
    /^\/api\/billDetailHist\/billText\/[SA][1-9]\d{0,4}\/\d{4}$/.test(
      url.pathname,
    );
  const text =
    NJ_TEXT_HOSTS.has(url.hostname) && /^\/bills\//i.test(url.pathname);
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !(api || text)
  )
    throw new AppError(
      'SSRF_BLOCKED',
      'The New Jersey full-text source address is not allowed.',
    );
}
