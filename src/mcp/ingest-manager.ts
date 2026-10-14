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
import { ToolError } from './errors.js';

export interface JobProgress {
  stage: IngestProgress['stage'];
  done?: number;
  total?: number;
}

type JobState = 'running' | 'ready' | 'failed';

export interface Job {
  readonly url: string;
  state: JobState;
  progress: JobProgress;
  result?: IngestResult;
  error?: unknown;
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
  /** Finished jobs kept for repeat calls. */
  maxFinishedJobs?: number;
}

export type WaitOutcome = 'settled' | 'timeout' | 'aborted';

const HOUR_MS = 3_600_000;

export class IngestManager {
  private readonly jobs = new Map<string, Job>();
  private starts: number[] = [];
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
    this.starts = this.starts.filter((time) => time > cutoff);
    if (this.starts.length >= (this.options.maxStartsPerHour ?? 20))
      throw new ToolError(
        'RATE_LIMITED',
        'Too many new documents were ingested this hour. Try again later, or use a document that is already ingested.',
      );
    this.starts.push(this.now());

    const controller = new AbortController();
    const listeners = new Set<(progress: JobProgress) => void>();
    let finish!: () => void;
    const settled = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const job: Job = {
      url,
      state: 'running',
      progress: { stage: 'fetching' },
      controller,
      listeners,
      settled,
    };
    this.jobs.set(url, job);
    this.options
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
      .then(
        (result) => {
          job.state = 'ready';
          job.result = result;
        },
        (error: unknown) => {
          job.state = 'failed';
          job.error = error;
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

  private prune(): void {
    const finished = [...this.jobs.values()].filter((j) => j.state === 'ready');
    const max = this.options.maxFinishedJobs ?? 50;
    for (const job of finished.slice(0, Math.max(0, finished.length - max)))
      this.jobs.delete(job.url);
  }
}
