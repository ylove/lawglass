/** ID-only projection of the keyless congress-legislators directory. */
import { join } from 'node:path';
import { z } from 'zod';
import {
  configFileSystem,
  readPrivateJson,
  writePrivateJson,
  type ConfigFileSystem,
} from '../config-files.js';
import { AppError, HttpsUrl } from '../model/index.js';
import type { Fetcher } from '../pipeline/index.js';

export const LEGISLATORS_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const LEGISLATORS_URLS = {
  current:
    'https://unitedstates.github.io/congress-legislators/legislators-current.json',
  historical:
    'https://unitedstates.github.io/congress-legislators/legislators-historical.json',
} as const;

const BioguideId = z.string().regex(/^[A-Z]\d{6}$/);
const PageTitle = z.string().trim().min(1);

function isCongressSite(url: URL): boolean {
  return (
    !url.username &&
    !url.password &&
    !url.port &&
    ['house.gov', 'senate.gov'].some(
      (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
    )
  );
}

const OfficialUrl = HttpsUrl.refine((value) => {
  const url = URL.parse(value);
  return url !== null && isCongressSite(url);
});

/** No names are retained: callers cannot accidentally join on a name. */
export const Legislator = z
  .object({
    officialUrl: OfficialUrl.optional(),
    wikipedia: PageTitle.optional(),
    ballotpedia: PageTitle.optional(),
  })
  .strict();
export type Legislator = z.infer<typeof Legislator>;
export type LegislatorsDirectory = ReadonlyMap<string, Legislator>;

const Source = z.array(
  z.object({
    id: z.object({
      bioguide: BioguideId.optional(),
      wikipedia: PageTitle.optional(),
      ballotpedia: PageTitle.optional(),
    }),
    terms: z.array(
      z.object({
        start: z.iso.date(),
        url: z.url().optional(),
      }),
    ),
  }),
);
const Cache = z
  .object({
    version: z.literal(1),
    fetchedAt: z.iso.datetime(),
    legislators: z.record(BioguideId, Legislator),
  })
  .strict();

/** Older terms use HTTP; keep only congressional sites and canonicalize them to HTTPS. */
function officialUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !isCongressSite(url))
    return undefined;
  url.protocol = 'https:';
  return OfficialUrl.parse(url.href);
}

function projectSource(value: unknown): Map<string, Legislator> {
  const parsed = Source.safeParse(value);
  if (!parsed.success)
    throw new AppError('PARSE_FAILED', 'Invalid legislators directory.');
  const directory = new Map<string, Legislator>();
  for (const member of parsed.data) {
    const id = member.id.bioguide;
    if (!id) continue;
    if (directory.has(id))
      throw new AppError('PARSE_FAILED', 'Duplicate legislators directory id.');
    // Use the latest term, even if its URL is absent; an older site may belong to someone else.
    const latest = member.terms.reduce<
      (typeof member.terms)[number] | undefined
    >(
      (chosen, term) => (!chosen || term.start > chosen.start ? term : chosen),
      undefined,
    );
    const url = officialUrl(latest?.url);
    directory.set(id, {
      ...(url ? { officialUrl: url } : {}),
      ...(member.id.wikipedia ? { wikipedia: member.id.wikipedia } : {}),
      ...(member.id.ballotpedia ? { ballotpedia: member.id.ballotpedia } : {}),
    });
  }
  return directory;
}

export interface LegislatorsOptions {
  /** Inject safeFetch with its permanent raw-document cache bypassed on directory refreshes. */
  fetcher: Fetcher;
  configDir: string;
  fs?: ConfigFileSystem;
  now?: () => Date;
  signal?: AbortSignal;
}

async function loadSource(
  source: keyof typeof LEGISLATORS_URLS,
  options: LegislatorsOptions,
): Promise<Map<string, Legislator>> {
  const fs = options.fs ?? configFileSystem;
  const now = (options.now ?? (() => new Date()))();
  const path = join(
    options.configDir,
    'sponsors',
    `legislators-${source}.json`,
  );
  // This is a disposable cache. Corrupt, inaccessible or non-private files are cache misses.
  let cached: unknown;
  try {
    cached = await readPrivateJson(path, fs, () => undefined);
  } catch {
    cached = undefined;
  }
  const parsed = Cache.safeParse(cached);
  if (parsed.success) {
    const age = now.getTime() - Date.parse(parsed.data.fetchedAt);
    if (age >= 0 && age < LEGISLATORS_CACHE_TTL_MS)
      return new Map(Object.entries(parsed.data.legislators));
  }

  options.signal?.throwIfAborted();
  const result = await options.fetcher(LEGISLATORS_URLS[source], {
    signal: options.signal,
  });
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(result.bytes)) as unknown;
  } catch {
    throw new AppError('PARSE_FAILED', 'Invalid legislators directory JSON.');
  }
  const directory = projectSource(value);
  await writePrivateJson(
    path,
    {
      version: 1,
      fetchedAt: now.toISOString(),
      legislators: Object.fromEntries(directory),
    } satisfies z.infer<typeof Cache>,
    fs,
  );
  return directory;
}

/** Load historical members only when at least one requested id is missing from current. */
export async function loadLegislators(
  bioguideIds: readonly string[],
  options: LegislatorsOptions,
): Promise<LegislatorsDirectory> {
  options.signal?.throwIfAborted();
  const ids = bioguideIds.filter((id) => BioguideId.safeParse(id).success);
  if (ids.length === 0) return new Map();
  const current = await loadSource('current', options);
  if (ids.every((id) => current.has(id))) return current;
  const historical = await loadSource('historical', options);
  // Current always wins if the upstream files briefly overlap during a member's transition.
  return new Map([...historical, ...current]);
}
