import { NEW_YORK_HOSTS } from '../core/fetch/new-york.js';
import {
  NEW_JERSEY_HOSTS,
  assertNewJerseyFetch,
} from '../core/fetch/new-jersey.js';
import { BRAND, envVar } from '../core/brand.js';
import { assertHistoryUrl } from '../core/history/allowlist.js';
import { HISTORY_SOURCES } from '../core/history/resolve.js';
import { LEGISLATORS_URLS } from '../core/sponsors/legislators.js';
import { AppError } from '../core/model/index.js';

export const DEFAULT_INGEST_HOSTS = [
  ...NEW_YORK_HOSTS,
  ...NEW_JERSEY_HOSTS,
  'congress.gov',
  'www.congress.gov',
  'govinfo.gov',
  'www.govinfo.gov',
  'legislature.ohio.gov',
  'www.legislature.ohio.gov',
  'search-prod.lis.state.oh.us',
];

export function ingestHosts(
  env: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const override = env[envVar('INGEST_HOSTS')]?.trim();
  return new Set(
    (override ? override.split(',') : DEFAULT_INGEST_HOSTS)
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function checkIngestHost(url: string, hosts: ReadonlySet<string>): void {
  if (hosts.has(new URL(url).hostname.toLowerCase())) return;
  const message = `${BRAND.displayName} currently reads U.S. federal bills (congress.gov, govinfo.gov), Ohio legislation (legislature.ohio.gov), New York bills (nysenate.gov, nyassembly.gov), and New Jersey bills (njleg.state.nj.us, pub.njleg.gov). Other states are on the roadmap.`;
  throw new AppError('INVALID_INPUT', message, { userMessage: message });
}

/** Mapped history reads keep their adapter's policy even with a deployment host override. */
export function checkIngestFetchHost(
  url: URL,
  hosts: ReadonlySet<string>,
): void {
  // Senate landing pages are pasted inputs only; the resolver maps them to text hosts.
  if (url.hostname === 'nysenate.gov' || url.hostname === 'www.nysenate.gov')
    throw new AppError(
      'INVALID_INPUT',
      'The New York Senate landing page must be resolved to an official full-text source before fetching.',
    );
  // New Jersey landing hosts are allowed only for the bill-text JSON the resolver reads.
  if (NEW_JERSEY_HOSTS.includes(url.hostname)) assertNewJerseyFetch(url);
  if (hosts.has(url.hostname)) return;
  // Sponsor enrichment permits these exact published directory files, never arbitrary paths.
  if ((Object.values(LEGISLATORS_URLS) as string[]).includes(url.href)) return;
  const source = HISTORY_SOURCES.find((source) =>
    source.hosts.includes(url.hostname),
  );
  if (source) assertHistoryUrl(source.source, url);
  else checkIngestHost(url.href, hosts);
}
