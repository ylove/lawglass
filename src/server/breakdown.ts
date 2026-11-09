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
import {
  canSpend,
  currentJob,
  currentTier,
  isBudgetExhausted,
  isSpendGateStop,
  runInJob,
  spendGateOpen,
  stopCause,
  tierName,
  type JobScope,
} from '../core/cost/job.js';
import type { JobSettlement } from './job-end.js';
import { breakdownCacheHash } from '../core/breakdown/cache.js';
import { NO_EXAMPLE_NOTE } from '../core/breakdown/notes.js';
import {
  breakdownMaxUnitsFromEnv,
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
  /** Serve cached results only (like public mode, for this request): never start or resume a run. */
  readOnly?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown, ms: number) => void;
  /** Runs `begin` (which starts a paid generation) after the host admits it; throws to refuse. */
  admit?: (begin: BeginExample) => Promise<void>;
}

/** Starts an admitted example; the settlement hears how it ended (`aborted` if it never started). */
export type BeginExample = (settlement?: JobSettlement) => void;

/** The reason shown to readers for a stop caused by `cause`. */
const reasonOf = (cause: ReturnType<typeof stopCause>): StoppedReason =>
  cause === 'spend_gate' ? 'spend_gate' : 'budget_exhausted';

export interface BreakdownService {
  get(docId: string, options?: RequestOptions): Promise<BreakdownResponse>;
  /**
   * A (document, tier) was just paid for: forget its failure cool-downs and let a budget-stopped
   * run go on. Other tiers' marks stay.
   */
  resume?(docId: string, live?: JobScope): void;
  /** True when the pre-drawn examples for this tier are all stored (or none are drawn ahead). */
  examplesComplete?(docId: string): Promise<boolean>;
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
  reportPicturesStopped?(
    docId: string,
    tier?: string,
    reason?: StoppedReason,
  ): void;
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
  /** The job the pass belongs to; every call it makes runs in it. */
  scope: JobScope | undefined;
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

  // Background state is per (document, tier): a stop or a pass for one tier is not another's.
  const passKey = (docId: string, tier = currentTier()): string =>
    `${registry.configDir}\n${docId}\n${tier}`;
  const running = new Map<string, Set<() => void>>();
  /** The running breakdown's finished batches (also on disk, for readers after a restart). */
  const progress = new Map<
    string,
    { briefs: readonly SectionBrief[]; done: number; total: number }
  >();
  const failedAt = new Map<string, number>();
  /** The tier each failure or stop belongs to, so a top-up on one tier leaves the others alone. */
  const nameTier = new Map<string, string>();
  /** Failures caused by the host's spend gate: over as soon as it reopens. */
  const gateFailed = new Set<string>();
  /** Documents whose example pass ended on a spent budget. */
  const examplesStopped = new Map<string, StoppedReason>();
  /** When the picture drawing of a document ended on a spent budget (reported by pictures). */
  const picturesStoppedAt = new Map<
    string,
    { at: number; reason: StoppedReason }
  >();
  /** Why the examples or pictures of a document are missing, while that still holds. */
  function docStopReason(docId: string): StoppedReason | undefined {
    const mark = picturesStoppedAt.get(passKey(docId));
    if (
      mark &&
      (mark.reason === 'spend_gate'
        ? !spendGateOpen()
        : now() - mark.at < FAILED_RETRY_MS)
    )
      return mark.reason;
    const examples = examplesStopped.get(passKey(docId));
    return examples === 'spend_gate' && spendGateOpen() ? undefined : examples;
  }
  // Runs the job's budget cut short. Their briefs are shown for a while but never cached as final.
  const stopped = new Map<
    string,
    { at: number; briefs: SectionBrief[]; reason: StoppedReason }
  >();

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
    if (
      gateFailed.has(name) ? !spendGateOpen() : now() - failed < FAILED_RETRY_MS
    )
      return true;
    failedAt.delete(name);
    gateFailed.delete(name);
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
    nameTier.set(name, currentTier());
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
          // Parts an earlier, budget-stopped run wrote are never shown as fewer.
          const kept = stopped.get(name)?.briefs ?? [];
          progress.set(name, {
            briefs: briefs.length >= kept.length ? briefs : kept,
            ...counts,
          });
          // Under 'all', each finished batch's examples start drawing without waiting for the end.
          startPregeneration(docId, briefs, context.mode, false);
          notify(docId);
        },
      });
      if (stored?.stoppedReason) {
        // Written parts are never replaced by fewer, whatever the later run managed. They are
        // also on disk as checkpoints, so a run that goes on does not make them again.
        const kept = stopped.get(name)?.briefs ?? [];
        stopped.set(name, {
          at: now(),
          briefs: [
            ...(stored.briefs.length >= kept.length ? stored.briefs : kept),
          ],
          reason: reasonOf(stopCause()),
        });
      } else if (!stored) failedAt.set(name, now());
      else {
        stopped.delete(name);
        startPregeneration(docId, stored.briefs, stored.context);
        notify(docId);
      }
    })()
      .catch((error: unknown) => {
        if (isBudgetExhausted(error)) {
          // A spent budget is not a failure to cool down from; a closed gate resumes when it opens.
          if (!isSpendGateStop(error)) failedAt.set(name, now());
          stopped.set(name, {
            at: now(),
            briefs: [...(progress.get(name)?.briefs ?? [])],
            reason: reasonOf(stopCause()),
          });
        } else failedAt.set(name, now());
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
    const stoppedReason = stopped.get(name)?.reason ?? docStopReason(docId);
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
      if (!options.publicMode && !request.readOnly && request.start !== false) {
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
    if (options.publicMode || request.readOnly) return { status: 'disabled' };

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
    const halted = stopped.get(name);
    if (halted) {
      // What the budget let through stays until a run that finishes replaces it. A new run
      // starts only when this scope has budget again and the last stop is not fresh. That run
      // goes on from the checkpoints on disk, so the parts already written are not made again.
      // A closed spend gate is not a verdict on the budget: the run goes on once it reopens.
      const mayResume =
        request.start !== false &&
        canSpend() &&
        (halted.reason === 'spend_gate' ||
          now() - halted.at >= FAILED_RETRY_MS);
      if (!mayResume) {
        const counts = {
          done: halted.briefs.length,
          total,
          stoppedReason: halted.reason,
        };
        return halted.briefs.length > 0
          ? {
              status: 'cached',
              briefs: [...halted.briefs],
              // Parts the budget never reached are not "left out": nothing is claimed about them.
              omitted: 0,
              stoppedReason:
                halted.reason === 'spend_gate' ? 'spend_gate' : 'budget',
              progress: counts,
            }
          : {
              status: 'disabled',
              stoppedReason:
                halted.reason === 'spend_gate' ? 'spend_gate' : 'budget',
              progress: counts,
            };
      }
      progress.set(name, {
        briefs: halted.briefs,
        done: halted.briefs.length,
        total,
      });
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
    settlement?: JobSettlement,
  ): Promise<void> {
    const started = now();
    nameTier.set(name, currentTier());
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
        // Stored (a validated "no honest example" counts: it is a stored result).
        () => settlement?.end('ok'),
        (error: unknown) => {
          failedAt.set(name, now());
          if (isSpendGateStop(error)) gateFailed.add(name);
          onError?.(error, now() - started);
          return settlement?.end('failed', error);
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
    if (options.publicMode || request.readOnly) return { status: 'disabled' };

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
    const begin: BeginExample = (settlement) => {
      // Another look may have started this run while admission was pending; this admitted job
      // then did nothing, so the host can release it.
      if (running.has(name)) {
        void settlement?.end('aborted');
        return;
      }
      void startExample(
        docId,
        sectionId,
        name,
        context,
        request.onError,
        false,
        settlement,
      );
    };
    if (request.admit) await request.admit(begin);
    else begin();
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
        scope: currentJob(),
      };
      examplePasses.set(k, pass);
    }
    if (pass.stoppedAt !== undefined) {
      // Ended early (failures or a spent budget): try again only after the usual cool-down. A
      // closed spend gate is no verdict on the budget: go on as soon as it reopens.
      const gateStop = examplesStopped.get(k) === 'spend_gate';
      if (
        !(gateStop && canSpend(pass.scope)) &&
        now() - pass.stoppedAt < FAILED_RETRY_MS
      )
        return;
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
    // The caller's scope may belong to another request; the pass keeps the one it was made in.
    void runInJob(pass.scope, () => drainExamples(docId, pass));
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
      // What was queued but not drawn must be queueable again when the pass goes on.
      pass.queued.clear();
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
            stop(reasonOf(stopCause()));
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
      stop(isBudgetExhausted(error) ? reasonOf(stopCause()) : undefined);
    } finally {
      pass.running = false;
    }
  }

  /** Called when a document is paid for again: forget cool-downs and let stopped runs go on. */
  function resume(docId: string, live?: JobScope): void {
    const tier = live ? tierName(live.models) : undefined;
    // Only this tier's marks: another tier's reader did not pay.
    const mine = (name: string): boolean =>
      name.startsWith(`${docId}:`) &&
      (tier === undefined || nameTier.get(name) === tier);
    for (const name of [...failedAt.keys()])
      if (mine(name)) {
        failedAt.delete(name);
        gateFailed.delete(name);
      }
    for (const [name, halted] of stopped)
      if (mine(name)) halted.at = Number.NEGATIVE_INFINITY;
    // The example pass and the pictures of this tier go on too, from where they stopped, in the
    // live scope of the (document, tier).
    const k = passKey(docId, tier);
    const pass = examplePasses.get(k);
    if (pass) {
      pass.stoppedAt = undefined;
      pass.failures = 0;
      pass.queue.length = 0;
      pass.queued.clear();
      pass.scope = live ?? pass.scope;
    }
    examplesStopped.delete(k);
    picturesStoppedAt.delete(k);
    // Start the pass again now, in the live scope, from what is stored.
    if (pass && live)
      void runInJob(live, () =>
        get(docId, { wait: false }).catch(() => undefined),
      );
  }

  /** True when every example this tier draws ahead is stored (or none are drawn ahead). */
  async function examplesComplete(docId: string): Promise<boolean> {
    const policy = pregenerationMode(options);
    if (policy === 'off' || options.publicMode) return true;
    const llm = provider();
    if (!llm) return true;
    const doc = await registry.getDocument(docId);
    const context = await documentContext(runtime.backend, docId, doc.sections);
    if (policy === 'small' && context.mode !== 'whole') return true;
    const hit = await breakdowns.get(
      breakdownCacheKey(
        docId,
        llm,
        runtime.answerEndpoint,
        context.mode,
        unitCap,
      ),
    );
    const available =
      hit?.briefs.filter((b) => b.example === 'available') ?? [];
    if (
      !hit ||
      (policy === 'small' && available.length > MAX_PREGENERATED_EXAMPLES)
    )
      return Boolean(hit);
    for (const { sectionId } of available)
      if (
        !(await examples.has(
          sectionExampleKey(docId, sectionId, llm, context.mode),
        ))
      )
        return false;
    return true;
  }

  return {
    get,
    example,
    progressivePictures: isFullCoverage(unitCap),
    resume,
    examplesComplete,
    reportPicturesStopped: (docId, tier, reason = 'budget_exhausted') => {
      picturesStoppedAt.set(passKey(docId, tier), { at: now(), reason });
    },
    subscribe: (listener) => {
      listeners.push(listener);
    },
  };
}
