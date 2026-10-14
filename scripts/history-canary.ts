/** Local only: npm run history:canary. Never imported by a CI workflow. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { safeFetch, type SafeFetchResult } from '../src/core/fetch/index.js';
import { assertHistoryUrl } from '../src/core/history/allowlist.js';
import {
  chooseOhioVersion,
  ohioHistorySource,
  resolveOhio,
} from '../src/core/history/ohio-legislature.js';
import { readManifest, type Fixture } from './fixture-manifest.js';

export interface CanaryResult {
  name: string;
  ok: boolean;
  detail: string;
}

/** Fetch only constructed history URLs. Never fetch text, member links or amendment PDFs. */
export async function runHistoryCanary(
  fixtures: readonly Pick<Fixture, 'name' | 'jurisdiction' | 'url'>[],
  fetcher: (url: string) => Promise<SafeFetchResult>,
  now: () => Date = () => new Date(),
): Promise<CanaryResult[]> {
  const results: CanaryResult[] = [];
  for (const fixture of fixtures.filter(
    (item) => item.jurisdiction === 'Ohio',
  )) {
    try {
      const plan = resolveOhio(new URL(fixture.url));
      if (!plan) throw new Error('Unrecognized Ohio fixture URL.');
      const { history, sponsorProfiles } = await ohioHistorySource.read(
        plan,
        async (url) => {
          assertHistoryUrl('ohio', url);
          const result = await fetcher(url);
          assertHistoryUrl('ohio', result.finalUrl);
          return result;
        },
        now,
      );
      const latest = chooseOhioVersion(history);
      if (
        !history.actions.length ||
        !sponsorProfiles.length ||
        (plan.version &&
          !history.versions.some((item) => item.code === plan.version))
      )
        throw new Error('Expected versions, actions or sponsors are missing.');
      results.push({
        name: fixture.name,
        ok: true,
        detail: `${String(history.versions.length)} versions (latest ${latest}), ${String(history.actions.length)} actions, ${String(history.amendments.length)} amendments, ${String(sponsorProfiles.length)} sponsors/cosponsors`,
      });
    } catch {
      results.push({
        name: fixture.name,
        ok: false,
        detail: 'History unavailable: download or parser check failed.',
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ohio-history-canary-'));
  try {
    const results = await runHistoryCanary(readManifest().fixtures, (url) =>
      safeFetch(url, {
        cacheDir,
        refresh: true,
        acceptHistoryPage: true,
        validateUrl: (url) => {
          assertHistoryUrl('ohio', url);
        },
      }),
    );
    for (const result of results)
      console.log(
        `${result.ok ? 'PASS' : 'FAIL'} ${result.name}: ${result.detail}`,
      );
    if (!results.length || results.some((result) => !result.ok))
      process.exitCode = 1;
  } finally {
    await rm(cacheDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  await main();
