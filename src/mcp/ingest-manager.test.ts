import { expect, test } from 'vitest';
import { AppError } from '../core/model/index.js';
import type { IngestResult } from '../core/pipeline/index.js';
import { IngestManager } from './ingest-manager.js';

const result = { doc: { docId: 'd'.repeat(64) } } as unknown as IngestResult;

function manager(
  run: ConstructorParameters<typeof IngestManager>[0]['run'],
  extra: { now?: () => number; maxConcurrent?: number } = {},
): IngestManager {
  return new IngestManager({
    run,
    isRegistered: () => Promise.resolve(true),
    maxStartsPerHour: 2,
    ...extra,
  });
}

async function settle(m: IngestManager, url: string) {
  const job = await m.jobFor(url);
  await job.settled;
  return job;
}

test('refusals before any download are refunded; failures after it are not', async () => {
  const m = manager((url) =>
    url.includes('blocked')
      ? Promise.reject(new AppError('SSRF_BLOCKED'))
      : url.includes('bad')
        ? Promise.reject(new AppError('INVALID_INPUT'))
        : Promise.reject(new AppError('FETCH_FAILED')),
  );
  for (const url of ['blocked1', 'blocked2', 'bad1', 'bad2', 'blocked3']) {
    const job = await settle(m, `https://x.test/${url}`);
    m.consumeFailure(job);
  }
  // Still within the allowance of two: now two late failures use it up.
  for (const url of ['late1', 'late2'])
    m.consumeFailure(await settle(m, `https://x.test/${url}`));
  await expect(m.jobFor('https://x.test/late3')).rejects.toMatchObject({
    code: 'RATE_LIMITED',
  });
});

test('a cancel while still queued is refunded, a cancel mid-run is not', async () => {
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  const m = manager(
    (_url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
        void open.then(() => {
          resolve(result);
        });
      }),
    { maxConcurrent: 1 },
  );
  const running = await m.jobFor('https://x.test/running');
  const queued = await m.jobFor('https://x.test/queued');
  expect(queued.progress.queued).toBe(true);
  m.cancel(queued);
  await queued.settled;
  // The queued cancel gave its charge back, so one more start fits and the next is limited.
  const next = await m.jobFor('https://x.test/next');
  await expect(m.jobFor('https://x.test/over')).rejects.toMatchObject({
    code: 'RATE_LIMITED',
  });
  // Cancelling a job that was already running does not give its charge back.
  m.cancel(running);
  await running.settled;
  await expect(m.jobFor('https://x.test/over')).rejects.toMatchObject({
    code: 'RATE_LIMITED',
  });
  release();
  await next.settled;
});

test('a ready job answers repeat calls for a few minutes, then the URL is ingested again', async () => {
  let clock = 0;
  let runs = 0;
  const m = manager(
    () => {
      runs++;
      return Promise.resolve(result);
    },
    { now: () => clock },
  );
  const first = await settle(m, 'https://x.test/bill');
  expect((await m.jobFor('https://x.test/bill')) === first).toBe(true);
  clock += 4 * 60_000;
  expect((await m.jobFor('https://x.test/bill')) === first).toBe(true);
  expect(runs).toBe(1);
  // A New York bill page can change at the same address; after the TTL it is read afresh.
  clock += 2 * 60_000;
  const second = await settle(m, 'https://x.test/bill');
  expect(second).not.toBe(first);
  expect(runs).toBe(2);
});
