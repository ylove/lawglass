/**
 * Runs ingests for the MCP server in the background and lets a tool call wait for one briefly.
 *
 * An MCP tool call should answer in seconds, but a first ingest can download an embedding model
 * and embed a long bill. So a call waits up to `waitMs`, then reports `ingesting` while the work
 * carries on inside this server process; a repeat call with the same URL finds the same job
 * (one job per URL, so repeated or racing calls never start a second ingest). Two different URLs
 * for the same bytes meet in the core's per-document lock. Two server processes meet in the
 * registry's file lock.
 */
import type { IngestProgress, IngestResult } from '../core/pipeline/index.js';
import { AppError } from '../core/model/index.js';
import { ToolError } from './errors.js';

export interface JobProgress {
  stage: IngestProgress['stage'];
  done?: number;
  total?: number;
  /** Waiting for a free slot: too many ingests are already running. */
  queued?: boolean;
}

type JobState = 'running' | 'ready' | 'failed';

export interface Job {
  readonly url: string;
  state: JobState;
  progress: JobProgress;
  result?: IngestResult;
  error?: unknown;
  /** When the job became `ready`, for expiry. */
  finishedAt?: number;
  readonly controller: AbortController;
  readonly listeners: Set<(progress: JobProgress) => void>;
  /** Settles (never rejects) when the job is no longer running. */
  readonly settled: Promise<void>;
}

export interface IngestManagerOptions {
  run: (
    url: string,
    opts: { signal: AbortSignal; onProgress: (p: IngestProgress) => void },
  ) => Promise<IngestResult>;
  /** True when the document is still in the registry (a `ready` job is stale otherwise). */
  isRegistered: (docId: string) => Promise<boolean>;
  now?: () => number;
  /** New ingests allowed per rolling hour, so an agent loop can't run up cost or disk. */
  maxStartsPerHour?: number;
  /** Ingests running at once; the rest queue. Default 2 (PDF parsing and embedding are heavy). */
  maxConcurrent?: number;
  /** Finished jobs kept for repeat calls. */
  maxFinishedJobs?: number;
}

export type WaitOutcome = 'settled' | 'timeout' | 'aborted';

const HOUR_MS = 3_600_000;
/**
 * A `ready` job answers repeat calls for this long, then the URL is ingested afresh. It is
 * short so a page that changes at the same address (a New York bill that gains an amendment) is
 * re-read, yet long enough for a caller that timed out to come back and collect the result.
 */
const READY_TTL_MS = 5 * 60_000;
/** Refusals that happen before any bytes are downloaded, so they cost nothing to retry. */
const FREE_REFUSALS: ReadonlySet<string> = new Set([
  'INVALID_INPUT',
  'SSRF_BLOCKED',
]);

export class IngestManager {
  private readonly jobs = new Map<string, Job>();
  /** Start times that count toward the hourly cap; only a refusal before any download, or a cancel while still queued, is refunded. */
  private starts: { at: number }[] = [];
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly now: () => number;

  constructor(private readonly options: IngestManagerOptions) {
    this.now = options.now ?? Date.now;
  }

  /**
   * The job for `url`: the running one, a finished one to report, or a new one. A `ready` job
   * whose document has since been removed is replaced.
   */
  async jobFor(url: string): Promise<Job> {
    const existing = this.jobs.get(url);
    if (
      existing?.state === 'ready' &&
      existing.finishedAt !== undefined &&
      this.now() - existing.finishedAt > READY_TTL_MS
    )
      this.jobs.delete(url);
    else if (
      existing?.state === 'ready' &&
      existing.result &&
      !(await this.options.isRegistered(existing.result.doc.docId)) &&
      this.jobs.get(url) === existing
    )
      this.jobs.delete(url);
    // No await between this lookup and `start`, so racing calls share one job.
    return this.jobs.get(url) ?? this.start(url);
  }

  private start(url: string): Job {
    const cutoff = this.now() - HOUR_MS;
    this.starts = this.starts.filter((start) => start.at > cutoff);
    if (this.starts.length >= (this.options.maxStartsPerHour ?? 20))
      throw new ToolError(
        'RATE_LIMITED',
        'Too many new documents were ingested this hour. Try again later, or use a document that is already ingested.',
      );
    const charge = { at: this.now() };
    this.starts.push(charge);

    const controller = new AbortController();
    const listeners = new Set<(progress: JobProgress) => void>();
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      url,
      state: 'running',
      progress: {
        stage: 'fetching',
        queued: this.active >= this.maxConcurrent,
      },
      controller,
      listeners,
      settled,
    };
    this.jobs.set(url, job);
    let ran = false;
    this.acquire(controller.signal)
      .then((release) => {
        job.progress = { stage: 'fetching' };
        ran = true;
        return this.options
          .run(url, {
            signal: controller.signal,
            onProgress: (p) => {
              job.progress = {
                stage: p.stage,
                ...(p.done === undefined ? {} : { done: p.done }),
                ...(p.total === undefined ? {} : { total: p.total }),
              };
              for (const listener of listeners) listener(job.progress);
            },
          })
          .finally(release);
      })
      .then(
        (result) => {
          job.state = 'ready';
          job.result = result;
          job.finishedAt = this.now();
        },
        (error: unknown) => {
          job.state = 'failed';
          job.error = error;
          // Refund only what cost nothing: a refusal before any download, or a cancel while
          // still queued. A failure after the download (page limit, parse error) or a cancel
          // mid-run keeps its charge, or a loop over a big bad URL would be unbounded.
          const free =
            !ran ||
            (error instanceof AppError && FREE_REFUSALS.has(error.code));
          if (free)
            this.starts = this.starts.filter((start) => start !== charge);
        },
      )
      .finally(() => {
        this.prune();
        finish();
      });
    return job;
  }

  /** A failed job is reported once, then forgotten so the next call retries. */
  consumeFailure(job: Job): unknown {
    if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
    return job.error;
  }

  /** Cancel one job (the caller cancelled the request) and forget it. */
  cancel(job: Job): void {
    job.controller.abort();
    if (this.jobs.get(job.url) === job) this.jobs.delete(job.url);
  }

  abortAll(): void {
    for (const job of this.jobs.values()) job.controller.abort();
    this.jobs.clear();
  }

  /** Waits for the job to finish, the timeout, or the caller's signal, whichever comes first. */
  wait(job: Job, waitMs: number, signal?: AbortSignal): Promise<WaitOutcome> {
    if (job.state !== 'running') return Promise.resolve('settled');
    if (signal?.aborted) return Promise.resolve('aborted');
    return new Promise<WaitOutcome>((resolve) => {
      const done = (outcome: WaitOutcome): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(outcome);
      };
      const onAbort = (): void => {
        done('aborted');
      };
      const timer = setTimeout(() => {
        done('timeout');
      }, waitMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      void job.settled.then(() => {
        done('settled');
      });
    });
  }

  private get maxConcurrent(): number {
    return Math.max(1, this.options.maxConcurrent ?? 2);
  }

  /** Takes a run slot, queueing behind the limit; rejects if the job is cancelled while queued. */
  private acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const take = (): void => {
        this.active++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active--;
          this.waiting.shift()?.();
        });
      };
      if (this.active < this.maxConcurrent) {
        take();
        return;
      }
      const entry = (): void => {
        signal.removeEventListener('abort', onAbort);
        take();
      };
      const onAbort = (): void => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      this.waiting.push(entry);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state === 'ready');
    const max = this.options.maxFinishedJobs ?? 50;
    for (const job of finished.slice(0, Math.max(0, finished.length - max)))
      this.jobs.delete(job.url);
  }
}
