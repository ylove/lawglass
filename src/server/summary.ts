/**
 * Summary on arrival (spec amendment 12, ADR 0008). Opening a document asks for its summary;
 * the answer cache makes sure it is generated at most once per provider, model and prompt
 * version, and public mode never starts a generation.
 */
import type { AnswerLog } from '../core/answer/log.js';
import { EXCERPT_FILTER_VERSION } from '../core/answer/excerpt-filter.js';
import {
  readingGradeCeiling,
  REGENERATION_VERSION,
} from '../core/answer/regenerate.js';
import { join } from 'node:path';
import { documentContext, type ContextMode } from '../core/answer/context.js';
import { referenceTokens } from '../core/answer/references.js';
import type { CliRuntime } from '../cli/runtime.js';
import {
  AnswerCache,
  answerCacheKey,
  type AnswerCacheKey,
} from '../core/answer-cache.js';
import { SUMMARY_PROMPT_VERSION } from '../core/chip-summary.js';
import { SCENARIO_PROMPT_VERSION } from '../core/scenario/generate.js';
import type { SummaryResponse } from '../core/model/index.js';
import { ask } from '../core/pipeline/index.js';

/**
 * The scenario rides inside the cached summary, so its prompt is part of the key: editing it
 * must not serve summaries whose scenarios were made the old way. Likewise the regeneration rule:
 * the cached text is the regenerated text.
 */
export function summaryCacheVersion(ceiling = readingGradeCeiling()): string {
  return `${SUMMARY_PROMPT_VERSION}.${SCENARIO_PROMPT_VERSION}.${REGENERATION_VERSION}.${EXCERPT_FILTER_VERSION}.${String(ceiling)}`;
}
export const SUMMARY_CACHE_VERSION = summaryCacheVersion();

function summaryKeyFor(
  runtime: CliRuntime,
  docId: string,
  provider: { id: string; model: string },
  context: ContextMode,
): AnswerCacheKey {
  return {
    docId,
    chipId: 'summary',
    provider: provider.id,
    model: provider.model,
    endpoint: runtime.answerEndpoint,
    promptVersion: summaryCacheVersion(),
    context,
  };
}

/** The automatic summary and targeted scenarios must look up exactly the same answer key. */
export async function summaryCacheKey(
  runtime: CliRuntime,
  docId: string,
  provider = runtime.answerProvider,
  signal?: AbortSignal,
): Promise<AnswerCacheKey> {
  const doc = await runtime.registry.getDocument(docId);
  const context = await documentContext(runtime.backend, docId, doc.sections, {
    signal,
    reservedTokens: referenceTokens(doc.references),
  });
  return summaryKeyFor(runtime, docId, provider, context.mode);
}

/**
 * Both keys a summary could be stored under. When the whole-bill scan that picks between them
 * fails (a transient backend error), a cached summary under either key is still good to serve:
 * the lookup then needs no backend at all.
 */
export function summaryCacheKeysWithoutScan(
  runtime: CliRuntime,
  docId: string,
  provider = runtime.answerProvider,
): AnswerCacheKey[] {
  return (['whole', 'excerpts'] as const).map((mode) =>
    summaryKeyFor(runtime, docId, provider, mode),
  );
}

/**
 * After a summary run ends without a cacheable answer (a decline, a failed call), wait this
 * long before the next poll may start another run. Without it a client polling every few
 * seconds would pay for a new model call each time.
 */
export const FAILED_RETRY_MS = 60_000;

export interface SummaryRequestOptions {
  wait?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown, ms: number) => void;
}

export interface SummaryService {
  /** Cache hit, a run in progress or just started, or `disabled`. Existing runs may be awaited. */
  get(docId: string, options?: SummaryRequestOptions): Promise<SummaryResponse>;
}

/** Polls subscribe to completion without attaching reactions to a possibly stuck generation. */
export function waitForSummary(
  waiters: Set<() => void>,
  waitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      waiters.delete(finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    waiters.add(finish);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function createSummaryService(
  runtime: CliRuntime,
  options: {
    publicMode: boolean;
    now?: () => number;
    waitMs?: number | undefined;
    log?: AnswerLog | undefined;
  },
): SummaryService {
  const now = options.now ?? Date.now;
  const { registry } = runtime;
  const cache = new AnswerCache({
    dir: join(registry.configDir, 'cache', 'answers'),
    // A removed document must not get an answer written back after the fact.
    isStillRegistered: (docId) =>
      registry.isRegistered(docId).catch(() => false),
  });
  const running = new Map<string, Set<() => void>>();
  const failedAt = new Map<string, number>();

  // Accepted trade-offs:
  // - Background runs are not aborted when the server closes or the tab goes away. For a
  //   localhost tool that is fine, and the finished answer is cached for next time.
  // - A transient scenario failure (a timeout, say) leaves a scenario-less summary cached. The
  //   summary text is still correct, and retrying would pay for the whole answer again.
  // - `disabled` doubles as "failed recently": during the cool-down (per process, in memory)
  //   a miss answers `disabled`, and the web client stops polling on it.
  function start(
    docId: string,
    key: AnswerCacheKey,
    name: string,
    onError?: SummaryRequestOptions['onError'],
  ): void {
    const started = now();
    const provider = runtime.answerProvider;
    const waiters = new Set<() => void>();
    running.set(name, waiters);
    // `getOrCompute` also de-duplicates across app instances in this process.
    void cache
      .getOrCompute(key, async () => {
        const result = await ask(
          docId,
          { chipId: 'summary' },
          {
            backend: runtime.backend,
            provider,
            registry,
            retrievalMode: runtime.retrievalMode,
            chips: runtime.chips,
            // Rewritten before it is cached, so a cache hit is already at reading level.
            // Cached for every reader and nobody is waiting: the normal ceiling.
            readingLevel: { background: true },
            log: options.log,
            // Not deferred: a single-subject bill's cached summary carries its scenario.
            scenario: { enabled: true },
          },
        );
        return result.answer;
      })
      .then(
        async () => {
          // A decline or truncated answer is returned but never stored; remember that.
          if (!(await cache.get(key))) failedAt.set(name, now());
        },
        (error: unknown) => {
          failedAt.set(name, now());
          onError?.(error, now() - started);
        },
      )
      .finally(() => {
        running.delete(name);
        for (const finish of waiters) finish();
      })
      .catch(() => undefined);
  }

  return {
    async get(docId, request = {}) {
      let provider;
      try {
        provider = runtime.answerProvider;
      } catch (error) {
        // Public visitors never see a configuration problem; an owner should.
        if (options.publicMode) return { status: 'disabled' };
        throw error;
      }
      let key: AnswerCacheKey;
      try {
        key = await summaryCacheKey(runtime, docId, provider, request.signal);
      } catch (error) {
        // The scan only decides which key to read. If it failed, a cached summary under
        // either key is still a valid answer, so serve it rather than fail a cache hit.
        if (request.signal?.aborted) throw error;
        for (const candidate of summaryCacheKeysWithoutScan(
          runtime,
          docId,
          provider,
        )) {
          const cached = await cache.get(candidate);
          if (cached) return { status: 'cached', answer: cached };
        }
        throw error;
      }
      const hit = await cache.get(key);
      if (hit) return { status: 'cached', answer: hit };
      // Public mode serves cache hits only: an anonymous visitor never spends the host's money.
      if (options.publicMode) return { status: 'disabled' };
      const name = answerCacheKey(key);
      const inFlight = running.get(name);
      if (inFlight) {
        if (request.wait !== false) {
          await waitForSummary(
            inFlight,
            options.waitMs ?? 20_000,
            request.signal,
          );
          if (!request.signal?.aborted) {
            const answer = await cache.get(key);
            if (answer) return { status: 'cached', answer };
          }
        }
        return { status: 'pending' };
      }
      const failed = failedAt.get(name);
      if (failed !== undefined) {
        if (now() - failed < FAILED_RETRY_MS) return { status: 'disabled' };
        failedAt.delete(name);
      }
      start(docId, key, name, request.onError);
      return { status: 'pending' };
    },
  };
}
