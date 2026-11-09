/**
 * Resource budgets for LLM-backed work (OWASP LLM10, unbounded consumption).
 *
 * Two independent defenses, both enforced in core so the CLI, server and MCP get them:
 *  - a concurrency cap per kind of work. Excess callers QUEUE (they are not failed), so a
 *    burst slows down instead of fanning out into unbounded provider calls;
 *  - a soft per-minute ceiling. Past it the call FAILS fast with `RATE_LIMITED`, because a
 *    queue that grows without bound is the same exhaustion problem moved elsewhere.
 *
 * Defaults are far above single-user use. Override with `${BRAND.envPrefix}_MAX_CONCURRENT_INGEST`,
 * `_MAX_CONCURRENT_ASK`, `_MAX_CONCURRENT_CLAUDE_CLI` and `_MAX_CALLS_PER_MINUTE`
 * (not `ConfigSettings`, which is strict).
 */
import {
  AppError,
  type LlmProvider,
  type LlmUsage,
  type TextRequest,
} from '../model/index.js';
import { envVar } from '../brand.js';
import { providerTimedOut } from '../llm/shared.js';
import {
  NOOP_USAGE_SINK,
  type UsageFeature,
  type UsageSink,
} from '../cost/usage.js';
import { assertBudget, chargeJob, currentJob } from '../cost/job.js';

export const DEFAULT_MAX_CONCURRENT_INGEST = 2;
export const DEFAULT_MAX_CONCURRENT_ASK = 4;
export const DEFAULT_MAX_CONCURRENT_CLAUDE_CLI = 2;
export const DEFAULT_MAX_CALLS_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

/** A FIFO counting semaphore whose waiters can be abandoned by an abort signal. */
export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(readonly max: number) {
    if (!Number.isInteger(max) || max < 1)
      throw new RangeError('Semaphore max must be a positive integer.');
  }

  get inFlight(): number {
    return this.active;
  }

  get queued(): number {
    return this.waiters.length;
  }

  /** Resolves with a one-shot `release`. Rejects (without taking a slot) if aborted while queued. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.max) {
      this.active += 1;
      return this.releaser();
    }
    return new Promise<() => void>((resolve, reject) => {
      const grant = (): void => {
        signal?.removeEventListener('abort', onAbort);
        // The slot was handed over by `release`, so `active` is already counted.
        resolve(this.releaser());
      };
      const onAbort = (): void => {
        const i = this.waiters.indexOf(grant);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('The operation was aborted.', 'AbortError'),
        );
      };
      this.waiters.push(grant);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next)
        next(); // hand the slot straight to the next waiter
      else this.active -= 1;
    };
  }
}

/** Sliding-window counter: at most `max` admissions in any `windowMs`. */
export class RateCeiling {
  private readonly stamps: number[] = [];

  constructor(
    readonly max: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = MINUTE_MS,
  ) {}

  /** Calls admitted in the current window. */
  used(): number {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] ?? t) >= this.windowMs)
      this.stamps.shift();
    return this.stamps.length;
  }

  /** Records one call, or throws `RATE_LIMITED` saying how long to wait. */
  admit(): void {
    const t = this.now();
    while (this.stamps.length > 0 && t - (this.stamps[0] ?? t) >= this.windowMs)
      this.stamps.shift();
    if (this.stamps.length >= this.max) {
      const oldest = this.stamps[0] ?? t;
      const waitSeconds = Math.max(
        1,
        Math.ceil((oldest + this.windowMs - t) / 1000),
      );
      throw new AppError(
        'RATE_LIMITED',
        `LLM call ceiling of ${String(this.max)} per minute reached.`,
        {
          userMessage: `Too many requests in the last minute (limit ${String(this.max)}). Please wait ${String(waitSeconds)} seconds and try again.`,
          details: { retryAfterSeconds: waitSeconds },
        },
      );
    }
    this.stamps.push(t);
  }
}

export type WorkKind = 'ingest' | 'ask';

export interface LimitsConfig {
  usageSink?: UsageSink;
  maxConcurrentIngest: number;
  maxConcurrentAsk: number;
  maxCallsPerMinute: number;
  /** How long background work waits for per-minute headroom before giving up. Default 65 s. */
  backgroundWaitMs?: number;
  /** How often it looks again. Default 1 s. */
  backgroundPollMs?: number;
}

/**
 * Background work (a breakdown nobody asked a question for, examples drawn ahead of time) may use
 * at most this share of the per-minute ceiling and, at most, half of the ask slots. Readers'
 * own questions always find headroom.
 */
export const BACKGROUND_SHARE = 0.5;

export class Limits {
  private readonly pools: Record<WorkKind, Semaphore>;
  private readonly background: Semaphore;
  private readonly ceiling: RateCeiling;
  private readonly backgroundWaitMs: number;
  private readonly backgroundPollMs: number;
  private readonly configuredSink: UsageSink;

  constructor(config: LimitsConfig, now: () => number = Date.now) {
    this.configuredSink = config.usageSink ?? NOOP_USAGE_SINK;
    this.pools = {
      ingest: new Semaphore(config.maxConcurrentIngest),
      ask: new Semaphore(config.maxConcurrentAsk),
    };
    this.background = new Semaphore(
      Math.max(1, Math.floor(config.maxConcurrentAsk * BACKGROUND_SHARE)),
    );
    this.ceiling = new RateCeiling(config.maxCallsPerMinute, now);
    this.backgroundWaitMs = config.backgroundWaitMs ?? 65_000;
    this.backgroundPollMs = config.backgroundPollMs ?? 1000;
  }

  /** In-flight and queued background calls, for tests. */
  backgroundPool(): Semaphore {
    return this.background;
  }

  /**
   * A provider for a multi-call job that holds a shared `ask` slot only DURING each model call,
   * so a reader's question waits at most one call, never a whole run. With `background`, the job
   * also yields to readers: it takes at most half the ask slots, and a call that would push the
   * per-minute ceiling past `BACKGROUND_SHARE` of it is refused with `RATE_LIMITED` before any
   * model call is made. Every call is still charged to the ceiling by `meter`.
   */
  paced(
    provider: LlmProvider,
    options: {
      background?: boolean;
      signal?: AbortSignal | undefined;
      feature?: UsageFeature;
    } = {},
  ): LlmProvider {
    const metered = this.meter(provider, options.feature);
    const background = options.background === true;
    const share = Math.max(1, Math.floor(this.ceiling.max * BACKGROUND_SHARE));
    return {
      get id() {
        return provider.id;
      },
      get model() {
        return provider.model;
      },
      streamText: (req) => metered.streamText(req),
      generateObject: async (req) => {
        // Either the job's own signal or the request's ends the wait for a slot.
        const signals = [options.signal, req.signal].filter(
          (s): s is AbortSignal => s !== undefined,
        );
        const signal =
          signals.length > 0 ? AbortSignal.any(signals) : undefined;
        // Refuse before queueing: a spent job must not hold a slot a reader could use.
        assertBudget();
        const releaseBackground = background
          ? await this.background.acquire(signal)
          : undefined;
        let releaseAsk: (() => void) | undefined;
        try {
          // Nobody is waiting on background work, so it waits for headroom (the window frees
          // as old calls age out) instead of failing a run that has already paid for batches.
          if (background) await this.waitForHeadroom(share, signal);
          releaseAsk = await this.acquire('ask', signal);
          if (background && this.ceiling.used() >= share)
            throw new AppError(
              'RATE_LIMITED',
              'Background work yields to readers near the per-minute ceiling.',
            );
          return await metered.generateObject(req);
        } finally {
          releaseAsk?.();
          releaseBackground?.();
        }
      },
    };
  }

  private async waitForHeadroom(
    share: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const deadline = Date.now() + this.backgroundWaitMs;
    while (this.ceiling.used() >= share && Date.now() < deadline) {
      signal?.throwIfAborted();
      await new Promise((resolve) =>
        setTimeout(resolve, this.backgroundPollMs),
      );
    }
  }

  pool(kind: WorkKind): Semaphore {
    return this.pools[kind];
  }

  /** Wait for a concurrency slot (queues). The caller must call the returned release once. */
  acquire(kind: WorkKind, signal?: AbortSignal): Promise<() => void> {
    return this.pools[kind].acquire(signal);
  }

  /**
   * Wrap a provider so each model call is charged to the per-minute ceiling when it is made
   * (summary batches, scenario generation and retries each count; calls that never reach a
   * model, such as a metadata-only chip, cost nothing). Past the ceiling the call fails fast.
   */
  meter(provider: LlmProvider, feature: UsageFeature = 'unknown'): LlmProvider {
    const sink = this.configuredSink;
    const objectFeature = (schemaName: string): UsageFeature =>
      schemaName === 'scenario' && feature !== 'examples'
        ? 'scenario'
        : feature;
    // Accounting failures must not discard a paid-for model answer or cause a retry.
    const report = async (
      usage: LlmUsage,
      callFeature = feature,
      estimated = false,
    ): Promise<void> => {
      // Read when the call finishes, inside the async chain that made it (ADR 0018, section 5).
      const job = currentJob();
      if (job) chargeJob(job, provider.model, usage);
      const event = {
        feature: callFeature,
        model: provider.model,
        usage: { ...usage },
        ...(estimated ? { estimated: true } : {}),
        ...(job ? { job: { ...job.context } } : {}),
      };
      try {
        await sink.record(event);
      } catch {
        /* The sink owns delivery/retry policy. */
      }
      try {
        await job?.onUsage?.(event);
      } catch {
        /* The host's accounting failing must not discard a paid-for answer. */
      }
    };
    return {
      // Lazy: some runtimes build the provider (and demand its API key) only on first use,
      // and a chip that makes no model call must not trigger that.
      get id() {
        return provider.id;
      },
      get model() {
        return provider.model;
      },
      streamText: (req) => {
        assertBudget();
        this.ceiling.admit();
        let partial: LlmUsage | undefined;
        const stream = provider.streamText({
          ...req,
          onPartialUsage: (usage) => {
            partial = usage;
            req.onPartialUsage?.(usage);
          },
        });
        return (async function* () {
          let finished = false;
          let failed = false;
          let chars = 0;
          try {
            for await (const event of stream) {
              if (event.type === 'text') chars += event.text.length;
              if (event.type === 'done') {
                finished = true;
                await report(event.usage);
              }
              yield event;
            }
          } catch (error) {
            failed = true;
            if (!finished && error instanceof AppError && error.usage)
              await report(error.usage);
            else if (!finished && partial) await report(partial);
            else if (
              !finished &&
              (chars > 0 || req.signal?.aborted || maybeBilled(error))
            )
              // A timeout or an overload mid-answer: the provider billed what it produced.
              await report(guess(req, chars), feature, true);
            throw error;
          } finally {
            // The reader left mid-answer: the provider billed what it had produced so far.
            if (!finished && !failed)
              await (partial
                ? report(partial)
                : report(guess(req, chars), feature, true));
          }
        })();
      },
      generateObject: async (req) => {
        assertBudget();
        this.ceiling.admit();
        let result;
        try {
          result = await provider.generateObject(req);
        } catch (error) {
          // A reply that arrived but was unusable (cut off, invalid) was still billed.
          if (error instanceof AppError && error.usage)
            await report(error.usage, objectFeature(req.schemaName));
          else if (req.signal?.aborted || maybeBilled(error))
            await report(
              { inputTokens: promptTokens(req), outputTokens: req.maxTokens },
              objectFeature(req.schemaName),
              true,
            );
          throw error;
        }
        await report(result.usage, objectFeature(req.schemaName));
        return result;
      },
    };
  }
}

/**
 * Only a timeout or an abort is charged an estimate: the provider had the request and may have
 * billed work it did. A refused connection, a DNS failure or an HTTP error never got that far.
 */
function maybeBilled(error: unknown): boolean {
  return providerTimedOut(error);
}

/** About four characters to a token, rounded up: a bound, not a tokenizer. */
function promptTokens(req: {
  system: string;
  messages?: unknown;
  prompt?: unknown;
}): number {
  return Math.ceil(
    (req.system.length + JSON.stringify(req.messages ?? req.prompt).length) / 4,
  );
}

/** What an abandoned stream is charged when the provider could not say: the prompt plus what was read. */
function guess(req: TextRequest, chars: number): LlmUsage {
  return {
    inputTokens: promptTokens(req),
    outputTokens: Math.min(req.maxTokens, Math.ceil(chars / 4)),
  };
}

/** A positive integer from the environment; anything else (unset, 0, "abc") keeps the default. */
function envInt(
  env: NodeJS.ProcessEnv,
  suffix: string,
  fallback: number,
): number {
  const raw = env[envVar(suffix)]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : fallback;
}

export function limitsConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): LimitsConfig {
  return {
    maxConcurrentIngest: envInt(
      env,
      'MAX_CONCURRENT_INGEST',
      DEFAULT_MAX_CONCURRENT_INGEST,
    ),
    maxConcurrentAsk: envInt(
      env,
      'MAX_CONCURRENT_ASK',
      DEFAULT_MAX_CONCURRENT_ASK,
    ),
    maxCallsPerMinute: envInt(
      env,
      'MAX_CALLS_PER_MINUTE',
      DEFAULT_MAX_CALLS_PER_MINUTE,
    ),
  };
}

let shared: Limits | undefined;
/** Process-wide limits, built from the environment on first use. */
export function sharedLimits(): Limits {
  shared ??= new Limits(limitsConfigFromEnv());
  return shared;
}
/** Test seam: forget the shared instance so the next call re-reads the environment. */
export function resetSharedLimits(): void {
  shared = undefined;
}

let cliPool: Semaphore | undefined;
/** At most N concurrent `claude` subprocesses per process (default 2). */
export function claudeCliPool(): Semaphore {
  cliPool ??= new Semaphore(
    envInt(
      process.env,
      'MAX_CONCURRENT_CLAUDE_CLI',
      DEFAULT_MAX_CONCURRENT_CLAUDE_CLI,
    ),
  );
  return cliPool;
}
export function resetClaudeCliPool(): void {
  cliPool = undefined;
}

/**
 * Limits for deliberate batch jobs (the eval harnesses): sequential real-provider calls would
 * trip the interactive per-minute ceiling. Concurrency stays at the configured values; only the
 * ceiling is lifted.
 */
export function batchLimits(env: NodeJS.ProcessEnv = process.env): Limits {
  return new Limits({
    ...limitsConfigFromEnv(env),
    maxCallsPerMinute: Number.MAX_SAFE_INTEGER,
  });
}
