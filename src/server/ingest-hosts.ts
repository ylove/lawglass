import { BRAND, envVar } from '../core/brand.js';
import { assertHistoryUrl } from '../core/history/allowlist.js';
import { HISTORY_SOURCES } from '../core/history/resolve.js';
import { LEGISLATORS_URLS } from '../core/sponsors/legislators.js';
import { AppError } from '../core/model/index.js';

export const DEFAULT_INGEST_HOSTS = [
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
  const message = `${BRAND.displayName} currently reads U.S. federal bills (congress.gov, govinfo.gov) and Ohio legislation (legislature.ohio.gov). Other states are on the roadmap.`;
  throw new AppError('INVALID_INPUT', message, { userMessage: message });
}

/** Mapped history reads keep their adapter's policy even with a deployment host override. */
export function checkIngestFetchHost(
  url: URL,
  hosts: ReadonlySet<string>,
): void {
  if (hosts.has(url.hostname)) return;
  // Sponsor enrichment permits these exact published directory files, never arbitrary paths.
  if ((Object.values(LEGISLATORS_URLS) as string[]).includes(url.href)) return;
  const source = HISTORY_SOURCES.find((source) =>
    source.hosts.includes(url.hostname),
  );
  if (source) assertHistoryUrl(source.source, url);
  else checkIngestHost(url.href, hosts);
}
