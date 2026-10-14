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
import {
  SCENARIO_PROMPT_VERSION,
  SCENARIO_SUBJECT_PROMPT_VERSION,
} from '../core/scenario/generate.js';
import type { AnswerResult, SummaryResponse } from '../core/model/index.js';
import { ask, runScenario } from '../core/pipeline/index.js';
import {
  ScenarioCache,
  type ScenarioCacheKey,
} from '../core/scenario/scenario-cache.js';
import { checkScenarioSubject } from '../core/scenario/subject.js';
import { defaultScenarioSubject } from './default-scenario.js';

/**
 * Summaries cached before the default scenario became its own call carry an inline scenario, so
 * the inline prompt stays part of the key: bumping it for no reason would regenerate every
 * cached summary. The default scenario has its own cache entry and needs no bump.
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
  const scenarios = new ScenarioCache({
    dir: join(registry.configDir, 'cache', 'answers'),
    now,
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
            // No inline scenario: the default one is its own call, `startScenario` below.
          },
        );
        return result.answer;
      })
      .then(
        async () => {
          // A decline or truncated answer is returned but never stored; remember that.
          const stored = await cache.get(key);
          if (!stored) failedAt.set(name, now());
          else startScenario(docId, stored);
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

  /** Where the default scenario is cached, and what it is about. Never throws. */
  async function scenarioTarget(
    docId: string,
    summary: AnswerResult,
  ): Promise<{ key: ScenarioCacheKey; subject: string } | undefined> {
    try {
      const provider = runtime.answerProvider;
      const doc = await registry.getDocument(docId);
      const checked = checkScenarioSubject(
        defaultScenarioSubject(doc, summary),
      );
      if (!checked.ok) return undefined;
      return {
        subject: checked.subject,
        key: {
          docId,
          subject: checked.subject,
          provider: provider.id,
          model: provider.model,
          promptVersion: SCENARIO_SUBJECT_PROMPT_VERSION,
        },
      };
    } catch {
      return undefined;
    }
  }

  /**
   * Generate the default scenario in the background (local mode only). `none` is cached with a
   * cool-down by the scenario cache; a thrown error is remembered here so polling cannot retry
   * it for `FAILED_RETRY_MS`. Either way the summary is simply served without a strip.
   */
  function startScenario(docId: string, summary: AnswerResult): void {
    const name = `scenario:${docId}`;
    if (running.has(name)) return;
    running.add(name);
    void scenarioTarget(docId, summary)
      .then(async (target) => {
        if (!target) return;
        const chunkIds = summary.citations
          .filter((citation) => citation.valid)
          .flatMap((citation) => citation.chunkIds);
        await runScenario(docId, target.subject, {
          backend: runtime.backend,
          provider: runtime.answerProvider,
          registry,
          retrievalMode: runtime.retrievalMode,
          cache: scenarios,
          now,
          summaryChunkIds: () => Promise.resolve(chunkIds),
          // The shared core limiter plugs in here once it lands (`limits`, #229).
        });
      })
      .catch(() => {
        failedAt.set(name, now());
      })
      .finally(() => {
        running.delete(name);
      });
  }

  /** The summary plus its default scenario when there is one, and whether one is still coming. */
  async function compose(
    docId: string,
    summary: AnswerResult,
  ): Promise<SummaryResponse> {
    // Summaries cached by an older version carry their own inline scenario; keep serving it.
    if (summary.scenario) return { status: 'cached', answer: summary };
    const target = await scenarioTarget(docId, summary);
    if (!target) return { status: 'cached', answer: summary };
    const hit = await scenarios.get(target.key);
    if (hit?.status === 'ok')
      return {
        status: 'cached',
        answer: { ...summary, scenario: hit.scenario },
      };
    // A `none` inside its cool-down, or public mode: the summary stands alone.
    if (hit?.status === 'none' || options.publicMode)
      return { status: 'cached', answer: summary };
    const name = `scenario:${docId}`;
    if (!running.has(name)) {
      const failed = failedAt.get(name);
      if (failed !== undefined && now() - failed < FAILED_RETRY_MS)
        return { status: 'cached', answer: summary };
      failedAt.delete(name);
      startScenario(docId, summary);
    }
    // `pending` with an answer: the summary is ready to show, the client keeps polling for the
    // scenario.
    return { status: 'pending', answer: summary };
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
        promptVersion: SUMMARY_CACHE_VERSION,
      };
      const hit = await cache.get(key);
      if (hit) return compose(docId, hit);
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
