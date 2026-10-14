/**
 * Offline document sources for eval. Real fixtures are read from `fixtures/downloads/` (never
 * committed); the fetcher below serves bytes from memory so ingest never touches the network.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { sniffFormat } from '../core/fetch/index.js';
import type { Fetcher } from '../core/pipeline/index.js';
import { AppError } from '../core/model/index.js';

export interface EvalFixture {
  /** Matches `GoldenSet.fixture`. */
  name: string;
  /** Identifies the document to `ingest`; used only as a key and for format sniffing. */
  url: string;
  bytes: Uint8Array;
  contentType: string;
}

/** A fetcher that serves only the given fixtures. Any other URL fails like a dead link. */
export function memoryFetcher(fixtures: readonly EvalFixture[]): Fetcher {
  const byUrl = new Map(fixtures.map((f) => [f.url, f]));
  return (url) => {
    const fixture = byUrl.get(url);
    if (!fixture)
      return Promise.reject(
        new AppError('FETCH_FAILED', `No offline fixture for ${url}.`),
      );
    return Promise.resolve({
      docId: createHash('sha256').update(fixture.bytes).digest('hex'),
      bytes: fixture.bytes,
      finalUrl: url,
      contentType: fixture.contentType,
      format: sniffFormat(fixture.bytes, fixture.contentType, url),
      fromCache: false,
    });
  };
}

const Manifest = z.object({
  fixtures: z.array(
    z.object({
      name: z.string(),
      format: z.enum(['xml', 'pdf', 'html', 'text']),
    }),
  ),
});

const CONTENT_TYPES = {
  xml: 'application/xml',
  pdf: 'application/pdf',
  html: 'text/html',
  text: 'text/plain',
} as const;

/** Mirrors scripts/fixture-manifest.ts: the downloaded file is `<name>.<ext>`. */
function fileName(name: string, format: keyof typeof CONTENT_TYPES): string {
  return `${name}.${format === 'text' ? 'txt' : format}`;
}

export interface FixtureLookup {
  fixture?: EvalFixture;
  /** Why the fixture could not be loaded (not in the manifest, or not downloaded). */
  missing?: string;
}

/**
 * Read one named fixture from `<fixturesDir>/manifest.json` and `<fixturesDir>/downloads/`.
 * Absence is reported, not thrown: fixtures are downloaded on demand and most checkouts lack them.
 */
export async function readDownloadedFixture(
  fixturesDir: string,
  name: string,
): Promise<FixtureLookup> {
  let manifest: z.infer<typeof Manifest>;
  try {
    manifest = Manifest.parse(
      JSON.parse(await readFile(join(fixturesDir, 'manifest.json'), 'utf8')),
    );
  } catch {
    return { missing: 'fixtures/manifest.json is missing or invalid' };
  }
  const entry = manifest.fixtures.find((f) => f.name === name);
  if (!entry) return { missing: 'not listed in fixtures/manifest.json' };
  const path = join(fixturesDir, 'downloads', fileName(name, entry.format));
  try {
    const bytes = new Uint8Array(await readFile(path));
    return {
      fixture: {
        name,
        url: pathToFileURL(path).href,
        bytes,
        contentType: CONTENT_TYPES[entry.format],
      },
    };
  } catch {
    return { missing: 'not downloaded (run npm run fixtures:fetch)' };
  }
}
