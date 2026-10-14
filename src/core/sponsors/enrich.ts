import type { NormalizedDoc } from '../model/index.js';
import { AppError } from '../model/index.js';
import type { Fetcher } from '../pipeline/index.js';
import {
  LEGISLATORS_URLS,
  loadLegislators,
  type LegislatorsDirectory,
} from './legislators.js';
import { enrichSponsorLinks, sponsorProfilesFromNames } from './links.js';

export interface SponsorEnrichmentContext {
  fetcher: Fetcher;
  configDir: string;
  now: () => Date;
  signal?: AbortSignal | undefined;
}

const DIRECTORY_URLS: ReadonlySet<string> = new Set(
  Object.values(LEGISLATORS_URLS),
);

/** Only the two published directory files may be read; nothing here comes from user input. */
function assertDirectoryUrl(url: URL): void {
  if (!DIRECTORY_URLS.has(url.href))
    throw new AppError('SSRF_BLOCKED', undefined, {
      userMessage: 'The sponsor directory address is not allowed.',
    });
}

/**
 * Add profile links to a document's sponsors (spec amendment 11). Returns the same object when
 * there is nothing to do.
 *
 * - Profiles from an official record (`metadata.sponsorProfiles`) are joined to the legislators
 *   directory by bioguide id. The directory read bypasses safeFetch's permanent raw cache
 *   (`refresh`), since that cache never expires and the directory changes every Congress.
 *   If the read fails the profiles keep the links they have: a missing directory must never
 *   block an ingest or invent a link.
 * - A document with no official record gets search-only profiles built from the sponsor names
 *   in its metadata. Those carry no ids, so they are never joined to the directory.
 */
export async function withSponsorLinks(
  doc: NormalizedDoc,
  context: SponsorEnrichmentContext,
  options: { fromRecord: boolean },
): Promise<NormalizedDoc> {
  const existing = doc.metadata.sponsorProfiles;
  // Already enriched on an earlier ingest, and no fresh record to redo it from.
  if (existing && !options.fromRecord) return doc;
  const profiles = existing ?? sponsorProfilesFromNames(doc.metadata.sponsors);
  if (profiles.length === 0) return doc;

  let directory: LegislatorsDirectory = new Map();
  if (profiles.some((profile) => profile.bioguideId)) {
    try {
      directory = await loadLegislators(
        profiles.flatMap((profile) =>
          profile.bioguideId ? [profile.bioguideId] : [],
        ),
        {
          configDir: context.configDir,
          now: context.now,
          signal: context.signal,
          fetcher: (url, fetchOptions) =>
            context.fetcher(url, {
              ...fetchOptions,
              validateUrl: assertDirectoryUrl,
              refresh: true,
            }),
        },
      );
    } catch (error) {
      if (context.signal?.aborted) throw error;
      // Non-fatal: leave the profiles exactly as the official record gave them.
      return doc;
    }
  }
  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      sponsorProfiles: enrichSponsorLinks(
        profiles,
        directory,
        doc.metadata.jurisdiction ?? undefined,
      ),
    },
  };
}
