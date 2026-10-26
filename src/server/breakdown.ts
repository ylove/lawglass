/**
 * Section by section (#276) and a per-section example (#277) as server services.
 *
 * Both follow the summary's shape (ADR 0008): the first look starts one background run, later
 * looks are answered from the disk cache or with `pending`, a failed run backs off for
 * `FAILED_RETRY_MS`, and public mode serves cache hits only so a visitor never spends the host's
 * money. Runs take a slot in the shared `ask` pool and are metered per minute (see
 * `core/pipeline/breakdown.ts`), so they cannot crowd out a reader's own questions.
 *
 * Pre-generation: after a small bill's breakdown is cached, its few examples are drawn in the
 * background, one at a time, so a reader usually sees them instantly. Large bills draw an
 * example only when asked.
 */
import type { CliRuntime } from '../cli/runtime.js';
import { envVar } from '../core/brand.js';
import { documentContext } from '../core/answer/context.js';
import { breakdownCacheHash } from '../core/breakdown/cache.js';
import { NO_EXAMPLE_NOTE } from '../core/breakdown/notes.js';
import { chooseBreakdownUnits } from '../core/breakdown/units.js';
import {
  AppError,
  type BreakdownResponse,
  type ScenarioResponse,
  type SectionBrief,
} from '../core/model/index.js';
import {
  breakdownCacheKey,
  runBreakdown,
  runSectionExample,
  sectionExampleKey,
} from '../core/pipeline/breakdown.js';
import {
  defaultBreakdownCache,
  defaultExampleCache,
} from '../core/pipeline/breakdown.js';
import { scenarioCacheHash } from '../core/scenario/scenario-cache.js';
import { EXAMPLE_FAILED_NOTE } from '../core/breakdown/notes.js';
import { FAILED_RETRY_MS, waitForSummary } from './summary.js';

/**
 * Pre-generation spends model calls the reader may never need, so an operator can turn it off
 * with `<PREFIX>_PREGENERATE_EXAMPLES=0`. Anything else (or unset) leaves it on.
 */
function pregenerationEnabled(override: boolean | undefined): boolean {
  return override ?? process.env[envVar('PREGENERATE_EXAMPLES')] !== '0';
}

/** A bill with more available examples than this is drawn on demand only. */
export const MAX_PREGENERATED_EXAMPLES = 8;

export interface RequestOptions {
  /** False answers at once (HEAD, tests); default waits up to `waitMs` for a run in progress. */
  wait?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown, ms: number) => void;
}

export interface BreakdownService {
  get(docId: string, options?: RequestOptions): Promise<BreakdownResponse>;
  example(
    docId: string,
    sectionId: string,
    options?: RequestOptions,
  ): Promise<ScenarioResponse>;
}

export interface BreakdownServiceOptions {
  publicMode: boolean;
  now?: () => number;
  waitMs?: number | undefined;
  /** Resolves when the document's summary is no longer being made, so it is never delayed. */
  afterSummary?: ((docId: string) => Promise<void>) | undefined;
  /** Test seam; default true. */
  pregenerate?: boolean | undefined;
}

/**
 * Documents whose pre-generation pass has run (or is running) in this process, keyed by library
 * and document. A pass is never repeated unless it ended in a failure: viewing a breakdown, from
 * any app instance, must not pay for examples again.
 */
const pregenerated = new Set<string>();

export function createBreakdownService(
  runtime: CliRuntime,
  options: BreakdownServiceOptions,
): BreakdownService {
  const now = options.now ?? Date.now;
  const { registry } = runtime;
  const breakdowns = defaultBreakdownCache(registry);
  const examples = defaultExampleCache(registry, now);

  const passKey = (docId: string): string => `${registry.configDir}\n${docId}`;
  const running = new Map<string, Set<() => void>>();
  const partial = new Map<string, readonly SectionBrief[]>();
  const failedAt = new Map<string, number>();

  /** Wake waiters when a run ends, whatever the outcome. */
  function settle(name: string): void {
    const waiters = running.get(name);
    running.delete(name);
    partial.delete(name);
    for (const finish of waiters ?? []) finish();
  }

  /** True while the name is cooling down after a failure; clears the mark once it is over. */
  function coolingDown(name: string): boolean {
    const failed = failedAt.get(name);
    if (failed === undefined) return false;
    if (now() - failed < FAILED_RETRY_MS) return true;
    failedAt.delete(name);
    return false;
  }

  async function waitFor(
    name: string,
    request: RequestOptions,
  ): Promise<boolean> {
    const inFlight = running.get(name);
    if (!inFlight) return false;
    if (request.wait !== false)
      await waitForSummary(inFlight, options.waitMs ?? 20_000, request.signal);
    return true;
  }

  function provider(): CliRuntime['answerProvider'] | undefined {
    try {
      return runtime.answerProvider;
    } catch (error) {
      // Public visitors never see a configuration problem; an owner should.
      if (options.publicMode) return undefined;
      throw error;
    }
  }

  // --- the breakdown ---------------------------------------------------------------------

  function startBreakdown(
    docId: string,
    name: string,
    context: Awaited<ReturnType<typeof documentContext>>,
    onError: RequestOptions['onError'],
  ): void {
    const started = now();
    running.set(name, new Set());
    void (async () => {
      // Never compete with the summary the reader is waiting for.
      await options.afterSummary?.(docId).catch(() => undefined);
      const stored = await runBreakdown(docId, {
        backend: runtime.backend,
        provider: runtime.answerProvider,
        registry,
        endpoint: runtime.answerEndpoint,
        context,
        cache: breakdowns,
        onProgress: (briefs) => {
          partial.set(name, briefs);
        },
      });
      if (!stored) failedAt.set(name, now());
      else startPregeneration(docId, stored.briefs, stored.context);
    })()
      .catch((error: unknown) => {
        failedAt.set(name, now());
        onError?.(error, now() - started);
      })
      .finally(() => {
        settle(name);
      });
  }

  async function get(
    docId: string,
    request: RequestOptions = {},
  ): Promise<BreakdownResponse> {
    const llm = provider();
    if (!llm) return { status: 'disabled' };
    const doc = await registry.getDocument(docId);
    // A bill that is all boilerplate has no parts to brief.
    if (chooseBreakdownUnits(doc.sections).units.length === 0)
      return { status: 'disabled' };
    const context = await documentContext(runtime.backend, docId, doc.sections);
    const key = breakdownCacheKey(
      docId,
      llm,
      runtime.answerEndpoint,
      context.mode,
    );
    const name = `${docId}:${breakdownCacheHash(key)}`;

    const hit = await breakdowns.get(key);
    if (hit) {
      if (!options.publicMode)
        startPregeneration(docId, hit.briefs, hit.context);
      return { status: 'cached', briefs: hit.briefs, omitted: hit.omitted };
    }
    // Public mode serves cache hits only: an anonymous visitor never spends the host's money.
    if (options.publicMode) return { status: 'disabled' };

    if (await waitFor(name, request)) {
      if (!request.signal?.aborted) {
        const done = await breakdowns.get(key);
        if (done)
          return {
            status: 'cached',
            briefs: done.briefs,
            omitted: done.omitted,
          };
      }
      const so_far = partial.get(name);
      return so_far?.length
        ? { status: 'pending', briefs: [...so_far] }
        : { status: 'pending' };
    }
    // A recent failure is an error the client can show with a retry, not "off": `disabled`
    // would hide the panel and the parts the reader was already reading.
    if (coolingDown(name))
      throw new AppError('PROVIDER_ERROR', 'Breakdown is cooling down.', {
        userMessage:
          "Couldn't finish reading the sections right now. Try again in a minute.",
      });
    startBreakdown(docId, name, context, request.onError);
    return { status: 'pending' };
  }

  // --- one part's example -----------------------------------------------------------------

  /** Starts the run for one part. The returned promise never rejects; failures are remembered. */
  function startExample(
    docId: string,
    sectionId: string,
    name: string,
    context: Awaited<ReturnType<typeof documentContext>>,
    onError: RequestOptions['onError'],
    background = false,
  ): Promise<void> {
    const started = now();
    running.set(name, new Set());
    return runSectionExample(docId, sectionId, {
      background,
      backend: runtime.backend,
      provider: runtime.answerProvider,
      registry,
      context,
      cache: examples,
      now,
    })
      .then(
        () => undefined,
        (error: unknown) => {
          failedAt.set(name, now());
          onError?.(error, now() - started);
        },
      )
      .finally(() => {
        settle(name);
      });
  }

  async function example(
    docId: string,
    sectionId: string,
    request: RequestOptions = {},
  ): Promise<ScenarioResponse> {
    const llm = provider();
    if (!llm) return { status: 'disabled' };
    const doc = await registry.getDocument(docId);
    if (
      !chooseBreakdownUnits(doc.sections).units.some((u) => u.id === sectionId)
    )
      throw new AppError('INVALID_INPUT', 'No such part of the bill.', {
        userMessage: 'That part of the bill could not be found.',
      });
    const context = await documentContext(runtime.backend, docId, doc.sections);

    // The brief already said there is nothing to illustrate: no model call, our own sentence.
    const brief = (
      await breakdowns.get(
        breakdownCacheKey(docId, llm, runtime.answerEndpoint, context.mode),
      )
    )?.briefs.find((b) => b.sectionId === sectionId);
    if (brief?.example === 'none')
      return { status: 'none', note: NO_EXAMPLE_NOTE };

    const key = sectionExampleKey(docId, sectionId, llm, context.mode);
    const name = `${docId}:example:${scenarioCacheHash(key)}`;
    const answered = async (): Promise<ScenarioResponse | undefined> => {
      const hit = await examples.get(key);
      if (hit?.status === 'ok') return { status: 'ok', scenario: hit.scenario };
      if (hit?.status === 'none')
        return { status: 'none', note: EXAMPLE_FAILED_NOTE };
      return undefined;
    };

    const cached = await answered();
    if (cached) return cached;
    if (options.publicMode) return { status: 'disabled' };

    if (await waitFor(name, request)) {
      if (!request.signal?.aborted) {
        const done = await answered();
        if (done) return done;
      }
      return { status: 'pending' };
    }
    if (coolingDown(name))
      throw new AppError('PROVIDER_ERROR', 'Example is cooling down.', {
        userMessage: "Couldn't draw an example right now. Try again.",
      });
    void startExample(docId, sectionId, name, context, request.onError);
    return { status: 'pending' };
  }

  // --- pre-generation ---------------------------------------------------------------------

  /**
   * Small bill, whole-bill mode, a handful of available examples: draw them in the background,
   * strictly one after another (each also takes an `ask` slot, so never more than the pool
   * allows). The first failure ends the pass; the next look at the breakdown may try again once
   * the cool-down has passed.
   */
  function startPregeneration(
    docId: string,
    briefs: readonly SectionBrief[],
    mode: 'whole' | 'excerpts',
  ): void {
    if (!pregenerationEnabled(options.pregenerate) || options.publicMode)
      return;
    if (mode !== 'whole' || pregenerated.has(passKey(docId))) return;
    const available = briefs.filter((b) => b.example === 'available');
    if (available.length === 0 || available.length > MAX_PREGENERATED_EXAMPLES)
      return;
    pregenerated.add(passKey(docId));
    void (async () => {
      const llm = provider();
      if (!llm) return;
      const doc = await registry.getDocument(docId);
      const context = await documentContext(
        runtime.backend,
        docId,
        doc.sections,
      );
      for (const { sectionId } of available) {
        const key = sectionExampleKey(docId, sectionId, llm, context.mode);
        const name = `${docId}:example:${scenarioCacheHash(key)}`;
        // Any stored result counts, even a `none` past its cool-down: never redraw it here.
        if (await examples.has(key)) continue;
        if (coolingDown(name)) {
          // Ended early: let a later look try the rest once it has cooled down.
          pregenerated.delete(passKey(docId));
          return;
        }
        // A reader may have asked for this one already; wait for that run instead of doubling it.
        const inFlight = running.get(name);
        if (inFlight) {
          await waitForSummary(inFlight, 120_000);
          continue;
        }
        await startExample(docId, sectionId, name, context, undefined, true);
        if (failedAt.has(name)) {
          // The first real failure ends the pass; a later look may retry once it cools down.
          pregenerated.delete(passKey(docId));
          return;
        }
      }
    })().catch(() => {
      pregenerated.delete(passKey(docId));
    });
  }

  return { get, example };
}
