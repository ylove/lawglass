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
 *
 * Full coverage (#382, opt-in): `breakdownMaxUnits` lifts the cap on briefed parts, every batch is
 * written to disk as it finishes (so readers see briefs as they arrive and a stopped run
 * resumes), and `pregenerateExamples: 'all'` draws every available example in the background,
 * one at a time, skipping a failed one and giving up on the document after
 * `MAX_EXAMPLE_FAILURES`. Every background loop here ends cleanly, keeping what it has written,
 * when the job budget is spent (`BUDGET_EXHAUSTED`), and says so in `progress.stoppedReason`.
 */
import type { BreakdownLog } from '../core/breakdown/generate.js';
import type { CliRuntime } from '../cli/runtime.js';
import { documentContext } from '../core/answer/context.js';
import { breakdownCacheHash } from '../core/breakdown/cache.js';
import { NO_EXAMPLE_NOTE } from '../core/breakdown/notes.js';
import {
  breakdownMaxUnitsFromEnv,
  isBudgetExhausted,
  isFullCoverage,
  pregenerateExamplesFromEnv,
  unitCapOf,
  type BreakdownMaxUnits,
  type PregenerateExamples,
  type StoppedReason,
} from '../core/breakdown/coverage.js';
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
 * with `<PREFIX>_PREGENERATE_EXAMPLES=0`, or up to every example with `=all`. Anything else (or
 * unset) is the small-bill rule below. The old boolean test seam maps onto the same three modes.
 */
function pregenerationMode(
  options: Pick<BreakdownServiceOptions, 'pregenerate' | 'pregenerateExamples'>,
): PregenerateExamples {
  if (options.pregenerateExamples) return options.pregenerateExamples;
  if (options.pregenerate !== undefined)
    return options.pregenerate ? 'small' : 'off';
  return pregenerateExamplesFromEnv();
}

/** A document's 'all' pass gives up after this many examples fail to draw. */
export const MAX_EXAMPLE_FAILURES = 3;

/** A bill with more available examples than this is drawn on demand only. */
export const MAX_PREGENERATED_EXAMPLES = 8;

export interface RequestOptions {
  /** False answers at once (HEAD, tests); default waits up to `waitMs` for a run in progress. */
  wait?: boolean;
  /**
   * False only reports (cached briefs, or `pending` while a run is in progress) and never starts
   * a run or reports its cool-down. For work that follows the breakdown (pictures).
   */
  start?: boolean;
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
  /**
   * True under full coverage: pictures are drawn for each finished group of briefs instead of
   * after the whole breakdown (#382).
   */
  readonly progressivePictures?: boolean;
  /** Told with the document id whenever a batch of briefs lands, and when the run is whole. */
  /** Pictures ended on a spent budget; readers are told in `progress.stoppedReason`. */
  reportPicturesStopped?(docId: string): void;
  subscribe?(listener: (docId: string) => void): void;
}

export interface BreakdownServiceOptions {
  log?: BreakdownLog | undefined;
  publicMode: boolean;
  now?: () => number;
  waitMs?: number | undefined;
  /** Resolves when the document's summary is no longer being made, so it is never delayed. */
  afterSummary?: ((docId: string) => Promise<void>) | undefined;
  /** Test seam; default true. Superseded by `pregenerateExamples`. */
  pregenerate?: boolean | undefined;
  /** Default: `<PREFIX>_BREAKDOWN_MAX_UNITS`, else 30. `'all'` briefs every substantive part. */
  breakdownMaxUnits?: BreakdownMaxUnits | undefined;
  /** Default: `<PREFIX>_PREGENERATE_EXAMPLES`, else `'small'`. */
  pregenerateExamples?: PregenerateExamples | undefined;
}

/**
 * Documents whose pre-generation pass has run (or is running) in this process, keyed by library
 * and document. A pass is never repeated unless it ended in a failure: viewing a breakdown, from
 * any app instance, must not pay for examples again.
 */
const pregenerated = new Set<string>();

/** The 'all' pass of one document: examples waiting to be drawn, drawn one at a time. */
interface ExamplePass {
  queue: string[];
  queued: Set<string>;
  running: boolean;
  failures: number;
  stoppedAt: number | undefined;
}
const examplePasses = new Map<string, ExamplePass>();

export function createBreakdownService(
  runtime: CliRuntime,
  options: BreakdownServiceOptions,
): BreakdownService {
  const now = options.now ?? Date.now;
  const { registry } = runtime;
  const breakdowns = defaultBreakdownCache(registry);
  const examples = defaultExampleCache(registry, now);
  const listeners: ((docId: string) => void)[] = [];
  const notify = (docId: string): void => {
    for (const listener of listeners) listener(docId);
  };
  const unitCap = unitCapOf(
    options.breakdownMaxUnits ?? breakdownMaxUnitsFromEnv(),
  );

  const passKey = (docId: string): string => `${registry.configDir}\n${docId}`;
  const running = new Map<string, Set<() => void>>();
  /** The running breakdown's finished batches (also on disk, for readers after a restart). */
  const progress = new Map<
    string,
    { briefs: readonly SectionBrief[]; done: number; total: number }
  >();
  const failedAt = new Map<string, number>();
  /** Runs that ended on purpose (a spent budget): reported as partial, not as a failure. */
  const stopped = new Map<string, StoppedReason>();
  /** Documents whose example pass ended on a spent budget. */
  const examplesStopped = new Map<string, StoppedReason>();
  /** When the picture drawing of a document ended on a spent budget (reported by pictures). */
  const picturesStoppedAt = new Map<string, number>();
  /** Why the examples or pictures of a document are missing, while that still holds. */
  function docStopReason(docId: string): StoppedReason | undefined {
    const at = picturesStoppedAt.get(passKey(docId));
    if (at !== undefined && now() - at < FAILED_RETRY_MS)
      return 'budget_exhausted';
    return examplesStopped.get(passKey(docId));
  }

  /** Wake waiters when a run ends, whatever the outcome. */
  function settle(name: string): void {
    const waiters = running.get(name);
    running.delete(name);
    progress.delete(name);
    for (const finish of waiters ?? []) finish();
  }

  /** True while the name is cooling down after a failure; clears the mark once it is over. */
  function coolingDown(name: string): boolean {
    const failed = failedAt.get(name);
    if (failed === undefined) return false;
    if (now() - failed < FAILED_RETRY_MS) return true;
    failedAt.delete(name);
    stopped.delete(name);
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
        unitCap,
        log: options.log,
        onProgress: (briefs, counts) => {
          progress.set(name, { briefs, ...counts });
          // Under 'all', each finished batch's examples start drawing without waiting for the end.
          startPregeneration(docId, briefs, context.mode, false);
          notify(docId);
        },
        onStopped: (reason) => {
          stopped.set(name, reason);
        },
      });
      if (!stored) failedAt.set(name, now());
      else {
        startPregeneration(docId, stored.briefs, stored.context);
        notify(docId);
      }
    })()
      .catch((error: unknown) => {
        failedAt.set(name, now());
        if (isBudgetExhausted(error)) stopped.set(name, 'budget_exhausted');
        onError?.(error, now() - started);
      })
      .finally(() => {
        settle(name);
      });
  }

  /** What a reader sees of a run that has not finished: its batches so far, and how far it got. */
  async function unfinished(
    docId: string,
    key: ReturnType<typeof breakdownCacheKey>,
    name: string,
    total: number,
    omitted: number,
  ): Promise<BreakdownResponse> {
    const live = progress.get(name);
    let seen: { briefs: readonly SectionBrief[]; done: number } | undefined =
      live;
    if (!seen) {
      // Not running here (a restart, or a run that stopped): the disk has the finished batches.
      const saved = await breakdowns.getPartial(key);
      if (saved)
        seen = {
          briefs: saved.briefs,
          done: Math.min(total, saved.briefs.length + saved.dropped),
        };
    }
    const stoppedReason = stopped.get(name) ?? docStopReason(docId);
    const counts = {
      done: seen?.done ?? 0,
      total,
      ...(stoppedReason ? { stoppedReason } : {}),
    };
    if (!seen?.briefs.length)
      return running.has(name) || stoppedReason
        ? { status: 'pending', progress: counts }
        : { status: 'pending' };
    return {
      status: 'partial',
      briefs: [...seen.briefs],
      omitted,
      progress: counts,
    };
  }

  async function get(
    docId: string,
    request: RequestOptions = {},
  ): Promise<BreakdownResponse> {
    const llm = provider();
    if (!llm) return { status: 'disabled' };
    const doc = await registry.getDocument(docId);
    const chosen = chooseBreakdownUnits(doc.sections, unitCap);
    // A bill that is all boilerplate has no parts to brief.
    if (chosen.units.length === 0) return { status: 'disabled' };
    const total = chosen.units.length;
    const context = await documentContext(runtime.backend, docId, doc.sections);
    const key = breakdownCacheKey(
      docId,
      llm,
      runtime.answerEndpoint,
      context.mode,
      unitCap,
    );
    const name = `${docId}:${breakdownCacheHash(key)}`;

    const hit = await breakdowns.get(key);
    if (hit) {
      // A report-only look (pictures) must not start the examples' model calls either.
      if (!options.publicMode && request.start !== false) {
        startPregeneration(docId, hit.briefs, hit.context);
        notify(docId);
      }
      const reason = docStopReason(docId);
      return {
        status: 'cached',
        briefs: hit.briefs,
        omitted: hit.omitted,
        ...(reason
          ? {
              progress: {
                done: total,
                total,
                stoppedReason: reason,
              },
            }
          : {}),
      };
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
      return unfinished(docId, key, name, total, chosen.omitted);
    }
    if (request.start === false) {
      // Report only: show the finished batches of a run that is not going (a restart, a stop).
      const idle = await unfinished(docId, key, name, total, chosen.omitted);
      return idle.status === 'partial' ? idle : { status: 'disabled' };
    }
    // A recent failure is an error the client can show with a retry, not "off": `disabled`
    // would hide the panel and the parts the reader was already reading. A run that ended on a
    // spent budget is not an error: the reader keeps what was written.
    if (coolingDown(name)) {
      if (stopped.has(name))
        return unfinished(docId, key, name, total, chosen.omitted);
      throw new AppError('PROVIDER_ERROR', 'Breakdown is cooling down.', {
        userMessage:
          "Couldn't finish reading the sections right now. Try again in a minute.",
      });
    }
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
      unitCap,
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
      !chooseBreakdownUnits(doc.sections, unitCap).units.some(
        (u) => u.id === sectionId,
      )
    )
      throw new AppError('INVALID_INPUT', 'No such part of the bill.', {
        userMessage: 'That part of the bill could not be found.',
      });
    const context = await documentContext(runtime.backend, docId, doc.sections);

    // The brief already said there is nothing to illustrate: no model call, our own sentence.
    const brief = (
      await breakdowns.get(
        breakdownCacheKey(
          docId,
          llm,
          runtime.answerEndpoint,
          context.mode,
          unitCap,
        ),
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
   * Which examples are drawn ahead, by `pregenerateExamples`:
   *  - `small` (default): once the breakdown is cached, a whole-bill-mode bill with at most
   *    `MAX_PREGENERATED_EXAMPLES` available parts has them drawn, one pass per document per
   *    process, ending at the first failure.
   *  - `all`: every available part, as each batch of briefs completes (see `startAllExamples`).
   *  - `off`: none.
   */
  function startPregeneration(
    docId: string,
    briefs: readonly SectionBrief[],
    mode: 'whole' | 'excerpts',
    complete = true,
  ): void {
    const policy = pregenerationMode(options);
    if (policy === 'off' || options.publicMode) return;
    if (policy === 'all') {
      enqueueExamples(docId, briefs);
      return;
    }
    if (!complete) return;
    startSmallPass(docId, briefs, mode);
  }

  /**
   * Small bill, whole-bill mode, a handful of available examples: draw them in the background,
   * strictly one after another (each also takes an `ask` slot, so never more than the pool
   * allows). The first failure ends the pass; the next look at the breakdown may try again once
   * the cool-down has passed.
   */
  function startSmallPass(
    docId: string,
    briefs: readonly SectionBrief[],
    mode: 'whole' | 'excerpts',
  ): void {
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

  /** Adds the briefs' available examples to the document's pass and starts it if it is idle. */
  function enqueueExamples(
    docId: string,
    briefs: readonly SectionBrief[],
  ): void {
    const k = passKey(docId);
    let pass = examplePasses.get(k);
    if (!pass) {
      pass = {
        queue: [],
        queued: new Set(),
        running: false,
        failures: 0,
        stoppedAt: undefined,
      };
      examplePasses.set(k, pass);
    }
    if (pass.stoppedAt !== undefined) {
      // Ended early (failures or a spent budget): try again only after the usual cool-down.
      if (now() - pass.stoppedAt < FAILED_RETRY_MS) return;
      pass.stoppedAt = undefined;
      pass.failures = 0;
      pass.queued.clear();
      examplesStopped.delete(k);
    }
    for (const brief of briefs) {
      if (brief.example !== 'available' || pass.queued.has(brief.sectionId))
        continue;
      pass.queued.add(brief.sectionId);
      pass.queue.push(brief.sectionId);
    }
    if (pass.running || pass.queue.length === 0) return;
    pass.running = true;
    void drainExamples(docId, pass);
  }

  /**
   * One example at a time. A failed one is skipped and the pass goes on; the third failure in a
   * document ends it. A spent budget ends it at once and is reported, not counted as a failure.
   */
  async function drainExamples(
    docId: string,
    pass: ExamplePass,
  ): Promise<void> {
    const k = passKey(docId);
    const stop = (reason?: StoppedReason): void => {
      pass.stoppedAt = now();
      pass.queue.length = 0;
      if (reason) examplesStopped.set(k, reason);
    };
    try {
      const llm = provider();
      if (!llm) {
        pass.queue.length = 0;
        return;
      }
      const doc = await registry.getDocument(docId);
      const context = await documentContext(
        runtime.backend,
        docId,
        doc.sections,
      );
      for (let sectionId = pass.queue.shift(); sectionId !== undefined;) {
        const key = sectionExampleKey(docId, sectionId, llm, context.mode);
        const name = `${docId}:example:${scenarioCacheHash(key)}`;
        const inFlight = running.get(name);
        if (inFlight) {
          // A reader asked for this one already; wait for that run instead of doubling it.
          await waitForSummary(inFlight, 120_000);
        } else if (!(await examples.has(key)) && !coolingDown(name)) {
          let error: unknown;
          await startExample(
            docId,
            sectionId,
            name,
            context,
            (e) => {
              error = e;
            },
            true,
          );
          if (isBudgetExhausted(error)) {
            stop('budget_exhausted');
            return;
          }
          if (failedAt.has(name) && ++pass.failures >= MAX_EXAMPLE_FAILURES) {
            stop();
            return;
          }
        }
        sectionId = pass.queue.shift();
      }
    } catch (error) {
      stop(isBudgetExhausted(error) ? 'budget_exhausted' : undefined);
    } finally {
      pass.running = false;
    }
  }

  return {
    get,
    example,
    progressivePictures: isFullCoverage(unitCap),
    reportPicturesStopped: (docId) => {
      picturesStoppedAt.set(passKey(docId), now());
    },
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
}
