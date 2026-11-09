/**
 * Coverage pass (#382): how much of a bill gets a brief, a picture and an example once the
 * server runs in full-coverage mode.
 *
 *   <PREFIX>_BREAKDOWN_MAX_UNITS=all <PREFIX>_PREGENERATE_EXAMPLES=all <cli> serve
 *   npx tsx scripts/coverage-pass.ts '<launch url printed by serve>' <bill url>...
 *
 * For each bill it ingests the URL, waits for the whole breakdown, then for its pictures, then
 * asks for every example, and prints one block per bill:
 *   - eligible briefs: those whose brief says an example is available (the target is at least
 *     90% of them with both a picture and an example);
 *   - how many of those have a picture, and an example;
 *   - why the rest do not (drop reasons).
 *
 * It spends whatever the server's providers cost, so point it at a server you mean to run it
 * against. Tests run it against the mock provider, offline.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import {
  BreakdownResponse,
  IngestEvent,
  PicturesResponse,
  ScenarioResponse,
  type SectionBrief,
} from '../src/core/model/index.js';
import { readSseEvents } from '../src/web/sse.js';

export interface CoverageOptions {
  /** The server, or the launch link `serve` prints (its `?k=` key is exchanged for a session). */
  server: string;
  bills: readonly string[];
  /** Test seam; default the global fetch. */
  fetch?: typeof fetch;
  pollMs?: number;
  /** Give up on a stage that makes no progress for this long. */
  stallMs?: number;
  log?: (line: string) => void;
}

export interface BillCoverage {
  url: string;
  docId?: string;
  /** Briefs the breakdown made, and parts it left out. */
  briefs: number;
  omitted: number;
  eligible: number;
  withPicture: number;
  withExample: number;
  withBoth: number;
  /** Why an eligible brief lacks a picture or an example, with counts. */
  dropReasons: Record<string, number>;
  /** Set when the run ended early (a spent budget) or did not finish. */
  stopped?: string;
  error?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function bump(reasons: Record<string, number>, reason: string): void {
  reasons[reason] = (reasons[reason] ?? 0) + 1;
}

/** Polls `look` until it returns a value; gives up after `stallMs` without a new `progress`. */
async function pollUntil<T>(
  look: () => Promise<{ done: T } | { progress: number }>,
  pollMs: number,
  stallMs: number,
): Promise<T | undefined> {
  let best = -1;
  let lastChange = Date.now();
  for (;;) {
    const r = await look();
    if ('done' in r) return r.done;
    if (r.progress > best) {
      best = r.progress;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= stallMs) return undefined;
    await sleep(pollMs);
  }
}

export async function runCoveragePass(
  options: CoverageOptions,
): Promise<BillCoverage[]> {
  const doFetch = options.fetch ?? fetch;
  const log = options.log ?? (() => undefined);
  const pollMs = options.pollMs ?? 2000;
  const stallMs = options.stallMs ?? 10 * 60_000;

  // A launch link carries a one-time key; the exchange answers with the session cookie.
  const base = new URL(options.server);
  let cookie: string | undefined;
  if (base.searchParams.has('k')) {
    const res = await doFetch(base, { redirect: 'manual' });
    cookie = res.headers.get('set-cookie')?.split(';')[0];
  }
  const api = (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('cookie', cookie);
    return doFetch(new URL(path, base.origin), { ...init, headers });
  };
  const getJson = async <T>(
    path: string,
    schema: { parse: (v: unknown) => T },
  ): Promise<T> => {
    const res = await api(path);
    if (!res.ok) throw new Error(`${path}: HTTP ${String(res.status)}`);
    return schema.parse(await res.json());
  };

  const reports: BillCoverage[] = [];
  for (const url of options.bills) {
    const report: BillCoverage = {
      url,
      briefs: 0,
      omitted: 0,
      eligible: 0,
      withPicture: 0,
      withExample: 0,
      withBoth: 0,
      dropReasons: {},
    };
    reports.push(report);
    try {
      log(`ingest ${url}`);
      const ingest = await api('/api/ingest', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      for await (const e of readSseEvents(ingest, IngestEvent)) {
        if (e.type === 'done') report.docId = e.doc.docId;
        if (e.type === 'error') throw new Error(e.error.message);
      }
      const docId = report.docId;
      if (!docId) throw new Error('The ingest did not finish.');

      // 1. The whole breakdown, as it arrives.
      let stoppedReason: string | undefined;
      const full = await pollUntil(
        async () => {
          const r = await getJson(
            `/api/docs/${docId}/breakdown`,
            BreakdownResponse,
          );
          stoppedReason = r.progress?.stoppedReason ?? stoppedReason;
          if (
            r.status === 'cached' ||
            r.status === 'disabled' ||
            r.progress?.stoppedReason
          )
            return { done: r };
          if (r.progress)
            log(
              `  ${String(r.progress.done)} of ${String(r.progress.total)} sections ready`,
            );
          return { progress: r.progress?.done ?? r.briefs?.length ?? 0 };
        },
        pollMs,
        stallMs,
      );
      if (!full) {
        report.error = 'The breakdown made no progress.';
        continue;
      }
      if (stoppedReason) report.stopped = stoppedReason;
      const briefs: readonly SectionBrief[] = full.briefs ?? [];
      report.briefs = briefs.length;
      report.omitted = full.omitted ?? 0;
      const eligible = briefs.filter((b) => b.example === 'available');
      report.eligible = eligible.length;

      // 2. Pictures: the entries whose text matches the brief, as the reader's page does.
      const picturesPath = `/api/docs/${docId}/breakdown/pictures`;
      const pictures = await pollUntil(
        async () => {
          const r = await getJson(picturesPath, PicturesResponse);
          if (r.status !== 'pending') return { done: r };
          return { progress: r.entries?.length ?? 0 };
        },
        pollMs,
        stallMs,
      );
      const drawn = new Set(
        (pictures?.entries ?? []).map((e) => `${e.sectionId ?? ''}\n${e.text}`),
      );
      const picturedIds = new Set(
        eligible
          .filter((b) => drawn.has(`${b.sectionId}\n${b.text}`))
          .map((b) => b.sectionId),
      );

      // 3. Examples, one at a time (the server draws them one at a time anyway).
      const exampled = new Set<string>();
      const exampleWhy = new Map<string, string>();
      for (const b of eligible) {
        const path = `/api/docs/${docId}/sections/${encodeURIComponent(b.sectionId)}/example`;
        const r = await pollUntil(
          async () => {
            try {
              const x = await getJson(path, ScenarioResponse);
              return x.status === 'pending' ? { progress: 0 } : { done: x };
            } catch {
              // A cool-down after a failure answers with an error.
              return { done: { status: 'disabled' as const } };
            }
          },
          pollMs,
          stallMs,
        );
        if (r?.status === 'ok') exampled.add(b.sectionId);
        else
          exampleWhy.set(
            b.sectionId,
            r === undefined
              ? 'example: timed out'
              : r.status === 'none'
                ? 'example: no honest example'
                : 'example: failed or off',
          );
      }

      for (const b of eligible) {
        const hasPicture = picturedIds.has(b.sectionId);
        const hasExample = exampled.has(b.sectionId);
        if (hasPicture) report.withPicture++;
        if (hasExample) report.withExample++;
        if (hasPicture && hasExample) report.withBoth++;
        if (!hasPicture)
          bump(
            report.dropReasons,
            pictures === undefined
              ? 'picture: timed out'
              : pictures.status === 'none' || pictures.status === 'disabled'
                ? `picture: ${pictures.status}`
                : 'picture: not drawn or refused by the checks',
          );
        const why = exampleWhy.get(b.sectionId);
        if (why) bump(report.dropReasons, why);
      }
      if (report.stopped)
        bump(report.dropReasons, `stopped: ${report.stopped}`);
    } catch (error) {
      report.error = error instanceof Error ? error.message : 'Unknown error.';
    }
  }
  return reports;
}

const pct = (n: number, d: number): string =>
  d === 0 ? 'n/a' : `${((100 * n) / d).toFixed(0)}%`;

export function formatCoverage(reports: readonly BillCoverage[]): string {
  return reports
    .map((r) => {
      const lines = [
        r.url,
        `  briefs ${String(r.briefs)} (${String(r.omitted)} parts left out)`,
        `  eligible briefs (example available): ${String(r.eligible)}`,
        `  with a picture: ${String(r.withPicture)} (${pct(r.withPicture, r.eligible)})`,
        `  with an example: ${String(r.withExample)} (${pct(r.withExample, r.eligible)})`,
        `  with both: ${String(r.withBoth)} (${pct(r.withBoth, r.eligible)})`,
      ];
      const reasons = Object.entries(r.dropReasons);
      lines.push(
        reasons.length === 0
          ? '  drop reasons: none'
          : `  drop reasons: ${reasons.map(([k, v]) => `${k} x${String(v)}`).join('; ')}`,
      );
      if (r.stopped) lines.push(`  stopped early: ${r.stopped}`);
      if (r.error) lines.push(`  error: ${r.error}`);
      return lines.join('\n');
    })
    .join('\n\n');
}

async function main(): Promise<void> {
  const [server, ...bills] = process.argv.slice(2);
  if (!server || bills.length === 0) {
    console.error(
      'Usage: tsx scripts/coverage-pass.ts <server url> <bill url>...',
    );
    process.exitCode = 2;
    return;
  }
  const reports = await runCoveragePass({
    server,
    bills,
    log: (line) => {
      console.error(line);
    },
  });
  console.log(formatCoverage(reports));
  if (reports.some((r) => r.error)) process.exitCode = 1;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
