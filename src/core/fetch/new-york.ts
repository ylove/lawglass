import { AppError } from '../model/index.js';

const SENATE_HOSTS = new Set(['nysenate.gov', 'www.nysenate.gov']);
const ASSEMBLY_HOSTS = new Set(['nyassembly.gov', 'www.nyassembly.gov']);
const PDF_HOST = 'legislation.nysenate.gov';
export const NEW_YORK_HOSTS = [...SENATE_HOSTS, ...ASSEMBLY_HOSTS, PDF_HOST];
export interface NewYorkResolution {
  textUrl: string;
  /** An unversioned bill page reads Assembly's current full text afresh. */
  latest: boolean;
}

function billUrlError(): AppError {
  return new AppError('INVALID_INPUT', undefined, {
    userMessage:
      'Paste a New York Senate bill page, an Assembly /leg/?bn=S01234&term=2025 URL, or a legislation.nysenate.gov/pdf/bills/2025/S1234A version URL.',
  });
}

/**
 * Anchored, keyless mapping. Assembly ignores amendment letters in `bn` and always serves
 * the current text, so named versions MUST use the Senate PDF endpoint. No scraped link is
 * followed. A direct unlettered PDF explicitly names the introduced version.
 */
export function resolveNewYork(input: string): NewYorkResolution | undefined {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (!NEW_YORK_HOSTS.includes(url.hostname)) return undefined;
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    /\\|\/(?:\.|\.\.)\//.test(input) ||
    url.pathname.includes('%')
  )
    throw billUrlError();
  let year: string | undefined;
  let bill: string | undefined;
  let amendment: string | undefined;
  let latest = true;
  if (SENATE_HOSTS.has(url.hostname)) {
    const match =
      /^\/legislation\/bills\/(\d{4})\/([SA]0*[1-9]\d{0,5})([A-Z])?(?:\/amendment\/([A-Z0])|\/text)?\/?$/i.exec(
        url.pathname,
      );
    if (
      !match ||
      (match[3] &&
        match[4] &&
        match[3].toUpperCase() !== match[4].toUpperCase())
    )
      throw billUrlError();
    [, year, bill] = match;
    amendment = match[4] ?? match[3];
    latest = !amendment;
  } else if (ASSEMBLY_HOSTS.has(url.hostname)) {
    if (
      !/^\/leg\/?$/.test(url.pathname) ||
      url.searchParams.getAll('bn').length !== 1 ||
      url.searchParams.getAll('term').length !== 1
    )
      throw billUrlError();
    const match = /^([SA]0*[1-9]\d{0,5})([A-Z])?$/i.exec(
      url.searchParams.get('bn') ?? '',
    );
    if (!match || !/^\d{4}$/.test(url.searchParams.get('term') ?? ''))
      throw billUrlError();
    year = url.searchParams.get('term') ?? undefined;
    bill = match[1];
    amendment = match[2];
    latest = !amendment;
  } else {
    const match =
      /^\/pdf\/bills\/(\d{4})\/([SA]0*[1-9]\d{0,5})([A-Z])?(?:\.pdf)?\/?$/i.exec(
        url.pathname,
      );
    if (!match) throw billUrlError();
    [, year, bill, amendment] = match;
    latest = false;
  }
  if (!year || !bill || !/^(?:19|20)\d{2}$/.test(year)) throw billUrlError();
  const chamber = bill.charAt(0).toUpperCase();
  const number = String(Number(bill.slice(1)));
  return {
    textUrl: latest
      ? `https://nyassembly.gov/leg/?bn=${chamber}${number.padStart(5, '0')}&term=${year}&Text=Y`
      : `https://${PDF_HOST}/pdf/bills/${year}/${chamber}${number}${amendment && amendment !== '0' ? amendment.toUpperCase() : ''}`,
    latest,
  };
}

/** safeFetch invokes this on every redirect as well as on the final URL. */
export function assertNewYorkFetch(url: URL): void {
  if (
    url.protocol !== 'https:' ||
    url.port ||
    url.username ||
    url.password ||
    !(ASSEMBLY_HOSTS.has(url.hostname) || url.hostname === PDF_HOST)
  ) {
    throw new AppError(
      'SSRF_BLOCKED',
      'The New York full-text source address is not allowed.',
    );
  }
}
