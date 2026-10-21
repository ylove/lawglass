/**
 * Summary on arrival (spec amendment 12, ADR 0008). Opening a document asks for its summary;
 * the answer cache makes sure it is generated at most once per provider, model and prompt
 * version, and public mode never starts a generation.
 */
import { join } from 'node:path';
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
 * must not serve summaries whose scenarios were made the old way.
 */
export const SUMMARY_CACHE_VERSION = `${SUMMARY_PROMPT_VERSION}.${SCENARIO_PROMPT_VERSION}`;

/**
 * After a summary run ends without a cacheable answer (a decline, a failed call), wait this
 * long before the next poll may start another run. Without it a client polling every few
 * seconds would pay for a new model call each time.
 */
export const FAILED_RETRY_MS = 60_000;

export interface SummaryService {
  /** Cache hit, a run in progress or just started, or `disabled`. Never waits for the model. */
  get(docId: string): Promise<SummaryResponse>;
}

export function createSummaryService(
  runtime: CliRuntime,
  options: { publicMode: boolean; now?: () => number },
): SummaryService {
  const now = options.now ?? Date.now;
  const { registry } = runtime;
  const cache = new AnswerCache({
    dir: join(registry.configDir, 'cache', 'answers'),
    // A removed document must not get an answer written back after the fact.
    isStillRegistered: (docId) =>
      registry.isRegistered(docId).catch(() => false),
  });
  const running = new Set<string>();
  const failedAt = new Map<string, number>();

  // Accepted trade-offs:
  // - Background runs are not aborted when the server closes or the tab goes away. For a
  //   localhost tool that is fine, and the finished answer is cached for next time.
  // - A transient scenario failure (a timeout, say) leaves a scenario-less summary cached. The
  //   summary text is still correct, and retrying would pay for the whole answer again.
  // - `disabled` doubles as "failed recently": during the cool-down (per process, in memory)
  //   a miss answers `disabled`, and the web client stops polling on it.
  function start(docId: string, key: AnswerCacheKey, name: string): void {
    running.add(name);
    const provider = runtime.answerProvider;
    // `getOrCompute` also de-duplicates across app instances in this process.
    cache
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
        () => {
          failedAt.set(name, now());
        },
      )
      .finally(() => {
        running.delete(name);
      })
      .catch(() => undefined);
  }

  return {
    async get(docId) {
      let provider;
      try {
        provider = runtime.answerProvider;
      } catch (error) {
        // Public visitors never see a configuration problem; an owner should.
        if (options.publicMode) return { status: 'disabled' };
        throw error;
      }
      const key: AnswerCacheKey = {
        docId,
        chipId: 'summary',
        provider: provider.id,
        model: provider.model,
        endpoint: runtime.answerEndpoint,
        promptVersion: SUMMARY_CACHE_VERSION,
      };
      const hit = await cache.get(key);
      if (hit) return { status: 'cached', answer: hit };
      // Public mode serves cache hits only: an anonymous visitor never spends the host's money.
      if (options.publicMode) return { status: 'disabled' };
      const name = answerCacheKey(key);
      if (running.has(name)) return { status: 'pending' };
      const failed = failedAt.get(name);
      if (failed !== undefined) {
        if (now() - failed < FAILED_RETRY_MS) return { status: 'disabled' };
        failedAt.delete(name);
      }
      start(docId, key, name);
      return { status: 'pending' };
    },
  };
}
