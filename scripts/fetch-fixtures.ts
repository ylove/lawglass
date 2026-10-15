import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../src/core/brand.js';
import {
  downloadsDirectory,
  fixtureFilename,
  readManifest,
  verifyFixture,
} from './fixture-manifest.js';
import type { FixtureManifest } from './fixture-manifest.js';

export interface FetchSummary {
  name: string;
  status: 'downloaded' | 'skipped' | 'mismatch' | 'error';
  bytes?: number;
  sha256?: string;
  message?: string;
}

/**
 * Room above the manifest size for a fixture that was re-rendered slightly larger. Such a file
 * still downloads in full, fails verification and is saved as `.mismatch` for review; anything
 * beyond this is abandoned mid-stream rather than buffered.
 */
export const BYTE_SLACK = 64 * 1024;

/** Read a body but stop, and cancel the download, the moment it passes `limit` bytes. */
export async function readWithBudget(
  response: Response,
  limit: number,
): Promise<Uint8Array> {
  const announced = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(announced) && announced > limit) {
    await response.body?.cancel();
    throw new Error(
      `Content-Length ${String(announced)} is far larger than the ${String(limit)}-byte budget`,
    );
  }
  if (!response.body) return new Uint8Array();
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(
          `Body is larger than the ${String(limit)}-byte budget; stopped after ${String(total)} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return data;
}

export function parseArguments(args: string[]): string[] | undefined {
  if (args.length === 0) return undefined;
  const [option, value] = args;
  if (args.length !== 2 || option !== '--only' || !value) {
    throw new Error('Usage: npm run fixtures:fetch -- [--only <name,...>]');
  }
  const names = value.split(',').map((name) => name.trim());
  if (names.some((name) => !name))
    throw new Error('--only requires nonempty fixture names');
  return names;
}

export async function fetchFixtures(options: {
  manifest: FixtureManifest;
  directory: string;
  version: string;
  only?: string[];
  fetcher?: typeof fetch;
}): Promise<FetchSummary[]> {
  const { manifest, directory, version, only, fetcher = fetch } = options;
  for (const name of only ?? []) {
    if (!manifest.fixtures.some((fixture) => fixture.name === name)) {
      throw new Error(`Unknown fixture: ${name}`);
    }
  }
  await mkdir(directory, { recursive: true });
  const results: FetchSummary[] = [];
  for (const fixture of manifest.fixtures.filter(
    ({ name }) => !only || only.includes(name),
  )) {
    const path = join(directory, fixtureFilename(fixture));
    try {
      const existing = await readFile(path).catch((error: unknown) => {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined;
        throw error;
      });
      if (existing && verifyFixture(existing, fixture).matches) {
        results.push({
          name: fixture.name,
          status: 'skipped',
          bytes: existing.byteLength,
          sha256: fixture.sha256,
        });
        continue;
      }
      const response = await fetcher(fixture.url, {
        signal: AbortSignal.timeout(60_000),
        headers: { 'User-Agent': `${BRAND.name}-fixtures/${version}` },
      });
      if (!response.ok)
        throw new Error(
          `HTTP ${String(response.status)} ${response.statusText}`,
        );
      // Fixture sizes are known, so the manifest sets the download budget: a server that sends
      // more (or never stops) cannot make this script buffer it. Size and hash are still
      // verified after the download.
      const data = await readWithBudget(response, fixture.bytes + BYTE_SLACK);
      const verification = verifyFixture(data, fixture);
      if (!verification.matches) {
        await writeFile(`${path}.mismatch`, data);
        results.push({
          name: fixture.name,
          status: 'mismatch',
          bytes: verification.bytes,
          sha256: verification.sha256,
          message: `Verification failed; saved ${path}.mismatch. Expected sha256 ${fixture.sha256}, ${String(fixture.bytes)} bytes; received sha256 ${verification.sha256}, ${String(verification.bytes)} bytes. Government sites sometimes re-render PDFs. Review the source and update fixtures/manifest.json deliberately (hash, bytes and retrievedAt).`,
        });
        continue;
      }
      // Write then rename, so an interrupted run never leaves a truncated file at `path`.
      await writeFile(`${path}.part`, data);
      await rename(`${path}.part`, path);
      results.push({
        name: fixture.name,
        status: 'downloaded',
        bytes: verification.bytes,
        sha256: verification.sha256,
      });
    } catch (error) {
      results.push({
        name: fixture.name,
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  try {
    const only = parseArguments(process.argv.slice(2));
    const { version } = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const results = await fetchFixtures({
      manifest: readManifest(),
      directory: downloadsDirectory,
      version,
      only,
    });
    console.table(
      results.map(({ name, status, bytes, sha256 }) => ({
        name,
        status,
        bytes,
        sha256,
      })),
    );
    for (const result of results) {
      if (result.message) console.error(`${result.name}: ${result.message}`);
    }
    if (
      results.some(({ status }) => status === 'error' || status === 'mismatch')
    )
      process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

// Importing the downloader in unit tests must never start a network request.
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
