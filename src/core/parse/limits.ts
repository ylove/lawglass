import { BRAND } from '../brand.js';
import { AppError } from '../model/index.js';

/** Resource policy is runtime-only; ConfigSettings is a frozen, strict contract. */
export interface ParseLimits {
  publicMode: boolean;
  maxPages: number;
  timeoutMs: number;
  maxChunks: number;
  maxHtmlBytes: number;
  maxNonPdfBytes: number;
}

export function readParseLimits(
  publicMode = false,
  env: NodeJS.ProcessEnv = process.env,
): ParseLimits {
  const positive = (suffix: string, fallback: number): number => {
    const name = `${BRAND.envPrefix}_${suffix}`;
    const raw = env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new AppError('INVALID_INPUT', `Invalid ${name}.`, {
        userMessage: `${name} must be a positive integer.`,
      });
    return value;
  };
  return {
    publicMode,
    maxPages: publicMode ? 200 : positive('MAX_PAGES', 5_000),
    timeoutMs: positive('PARSE_TIMEOUT_MS', publicMode ? 30_000 : 120_000),
    maxChunks: positive('MAX_CHUNKS', publicMode ? 3_000 : 20_000),
    maxHtmlBytes: (publicMode ? 5 : 15) * 1024 * 1024,
    maxNonPdfBytes: (publicMode ? 10 : 50) * 1024 * 1024,
  };
}

export interface ParseControl {
  signal?: AbortSignal | undefined;
  timeoutMs?: number | undefined;
}

/** Cooperative checkpoints also cover synchronous work, whose timers cannot run until it yields. */
export class ParseBudget {
  private readonly deadline: number;

  constructor(private readonly options: ParseControl = {}) {
    const timeout = options.timeoutMs ?? readParseLimits().timeoutMs;
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new AppError(
        'INVALID_INPUT',
        'Parse time budget must be positive.',
      );
    this.deadline = performance.now() + timeout;
    this.check();
  }

  check(): void {
    if (this.options.signal?.aborted)
      throw new AppError('PARSE_FAILED', 'Document parsing was aborted.', {
        userMessage: 'Document parsing was cancelled.',
      });
    if (performance.now() >= this.deadline)
      throw new AppError(
        'PARSE_FAILED',
        'Document parsing exceeded its time budget.',
        {
          userMessage:
            'The document took too long to parse. Try a smaller document.',
        },
      );
  }

  /** PDF.js promises may stall: cancel the wait as well as checking between pages. */
  async wait<T>(work: Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const signal = this.options.signal;
    let onAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        const fail = (): void => {
          try {
            this.check();
          } catch (error) {
            reject(
              error instanceof Error ? error : new AppError('PARSE_FAILED'),
            );
            return;
          }
          // Timers may fire just before the monotonic deadline. Re-arm rather than
          // leaving stalled PDF work waiting forever after an early callback.
          timer = setTimeout(
            fail,
            Math.max(1, Math.ceil(this.deadline - performance.now())),
          );
        };
        onAbort = fail;
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(
          fail,
          Math.max(1, Math.ceil(this.deadline - performance.now())),
        );
      });
      const value = await Promise.race([work, stopped]);
      this.check();
      return value;
    } finally {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
    }
  }
}

export function assertPageLimit(
  pages: number,
  maxPages: number,
  publicMode = false,
): void {
  if (pages > maxPages)
    throw new AppError('TOO_LARGE', 'PDF page limit exceeded.', {
      userMessage: `This ${publicMode ? 'public server' : 'server'} accepts documents up to ${String(maxPages)} pages.`,
    });
}

export function assertChunkLimit(count: number, maxChunks: number): void {
  if (count > maxChunks)
    throw new AppError('TOO_LARGE', 'Document chunk limit exceeded.', {
      userMessage: `This document exceeds the limit of ${String(maxChunks)} chunks. Try a smaller document.`,
    });
}
