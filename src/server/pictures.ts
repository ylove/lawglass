/**
 * Picture panels (#344) as a server service, in the shape of the summary and the breakdown
 * (ADR 0008): the first look starts one background run, later looks are answered from the disk
 * cache or with `pending`, and a failed run backs off for `FAILED_RETRY_MS`. Public mode serves
 * cache hits only, so a visitor never spends the host's money.
 *
 * Pictures are an enhancement. They are drawn only from text that is already cached (the
 * summary, the breakdown's briefs), never delay it, and any failure reads as `none`: the reader
 * keeps the words, with no error to dismiss.
 */
import { addLlmUsage } from '../core/cost/usage.js';
import { budgetRemaining, isBudgetExhausted } from '../core/cost/job.js';
import { AppError, type LlmUsage } from '../core/model/index.js';
import { registryLlmUsage } from '../core/registry.js';
import { join } from 'node:path';
import type { CliRuntime } from '../cli/runtime.js';
import { listItems } from '../core/answer/list-items.js';
import type {
  LlmProvider,
  PictureEntry,
  PicturesResponse,
} from '../core/model/index.js';
import {
  PictureCache,
  pictureCacheHash,
  pictureSourceHash,
  type PictureCacheKey,
  type PictureSource,
} from '../core/picture/cache.js';
import { drawPictures, type DrawnPictures } from '../core/picture/generate.js';
import {
  ITEMS_PER_CALL,
  PICTURE_PROMPT_VERSION,
  type PictureItem,
} from '../core/picture/prompt.js';
import { sharedLimits } from '../core/pipeline/limits.js';
import type { BreakdownService } from './breakdown.js';
import { LruMap } from './lru.js';
import {
  FAILED_RETRY_MS,
  waitForSummary,
  type SummaryService,
} from './summary.js';

export interface PictureRequestOptions {
  /** False answers at once (HEAD, tests); default waits up to `waitMs` for a run in progress. */
  wait?: boolean;
  /** False only reports: cached pictures, or `pending`; never starts a run. */
  start?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown, ms: number) => void;
}

export interface PictureService {
  /** Test seam: per-brief records remembered in memory. */
  knownRecords?(): number;
  get(
    docId: string,
    source: PictureSource,
    request?: PictureRequestOptions,
  ): Promise<PicturesResponse>;
  /** A document was just paid for: forget cool-downs and let a budget-stopped run go on. */
  resume(docId: string): void;
}

/** Counts only, never text: what a run drew and what the checks refused. */
export interface PictureLogEvent {
  event: 'pictures_made' | 'pictures_dropped';
  source: PictureSource;
  count: number;
  retried?: number;
  recovered?: number;
}

export interface PictureServiceOptions {
  publicMode: boolean;
  /** Test seam: how many per-brief picture records are remembered in memory. */
  knownLimit?: number | undefined;
  summary: SummaryService;
  breakdown: BreakdownService;
  now?: (() => number) | undefined;
  waitMs?: number | undefined;
  log?: ((event: PictureLogEvent) => void) | undefined;
  /** Test seam; defaults to the per-document cache beside the answer cache. */
  cache?: PictureCache | undefined;
}

/**
 * `PictureEntry.text` is capped by the contract; a longer item could be drawn and stored but
 * never read back, so it would be drawn again on every look. Such an item stays text-only.
 */
const MAX_ITEM_TEXT = 4000;

type SourceItems =
  | {
      status: 'ready';
      items: PictureItem[];
      /** False while a full-coverage breakdown is still being made (#382). */
      complete: boolean;
    }
  | { status: 'pending' | 'none' | 'disabled' };

/** Per-brief records kept in memory (each is also on disk); the oldest are forgotten first. */
const KNOWN_RECORDS = 10_000;

export function createPictureService(
  runtime: CliRuntime,
  options: PictureServiceOptions,
): PictureService {
  const now = options.now ?? Date.now;
  const { registry } = runtime;
  const cache =
    options.cache ??
    new PictureCache({
      dir: join(registry.configDir, 'cache', 'answers'),
      now,
      isStillRegistered: (id) => registry.isRegistered(id).catch(() => false),
    });
  const running = new Map<string, Set<() => void>>();
  const failedAt = new Map<string, number>();
  const budgetStoppedAt = new Map<string, number>();
  // Pictures drawn before the job's budget ran out: shown for a while, never cached as final.
  const stopped = new Map<string, { at: number; entries: PictureEntry[] }>();

  function provider(): LlmProvider | undefined {
    try {
      return runtime.extractProvider;
    } catch {
      // No key, or no provider configured: pictures are simply not drawn.
      return undefined;
    }
  }

  /** The items a picture can be drawn for, once their text is cached. Never starts a wait. */
  async function sourceItems(
    docId: string,
    source: PictureSource,
  ): Promise<SourceItems> {
    if (source === 'summary') {
      // Report only: asking for pictures must never start a summary run, nor fail with it.
      const summary = await options.summary
        .get(docId, { wait: false, start: false })
        .catch(() => ({ status: 'disabled' as const, answer: undefined }));
      if (summary.status !== 'cached' || !summary.answer)
        return { status: summary.status === 'pending' ? 'pending' : 'none' };
      const items = listItems(summary.answer.text).filter(
        (item) => item.text.length <= MAX_ITEM_TEXT,
      );
      return items.length > 0
        ? { status: 'ready', items, complete: true }
        : { status: 'none' };
    }
    const breakdown = await options.breakdown
      .get(docId, { wait: false, start: false })
      // A breakdown that is cooling down after a failure has nothing to draw yet.
      .catch(() => ({ status: 'disabled' as const, briefs: undefined }));
    if (breakdown.status === 'pending') return { status: 'pending' };
    // Under full coverage the finished batches of an unfinished breakdown are drawn already.
    const partial =
      breakdown.status === 'partial' && options.breakdown.progressivePictures;
    if (!partial && breakdown.status !== 'cached') return { status: 'none' };
    if (!breakdown.briefs?.length)
      return partial ? { status: 'pending' } : { status: 'none' };
    return {
      status: 'ready',
      complete: !partial,
      items: breakdown.briefs
        .map((brief, index) => ({
          index,
          text: brief.text,
          sectionId: brief.sectionId,
        }))
        .filter((item) => item.text.length <= MAX_ITEM_TEXT),
    };
  }

  function respond(entries: PictureEntry[]): PicturesResponse {
    return entries.length > 0
      ? { status: 'cached', entries }
      : { status: 'none' };
  }

  function start(
    key: PictureCacheKey,
    name: string,
    llm: LlmProvider,
    items: PictureItem[],
    onError: PictureRequestOptions['onError'],
    perBrief = false,
  ): Promise<void> {
    const started = now();
    // Forget cool-downs that are over, so the map holds only recent failures.
    for (const [other, at] of failedAt)
      if (started - at >= FAILED_RETRY_MS) failedAt.delete(other);
    running.set(name, new Set());
    const compute = async (): Promise<PictureEntry[]> => {
      // Right before the call: another look may have drawn some of these since they were
      // chosen, and a brief is never sent twice.
      if (perBrief) {
        const fresh = await stillMissing(key.docId, llm, items);
        if (fresh.length === 0) return [];
        items = fresh;
      }
      // Nobody waits on this; it yields to readers' own questions (`Limits.paced`).
      let usage: LlmUsage = { inputTokens: 0, outputTokens: 0 };
      let drawn: DrawnPictures;
      try {
        drawn = await drawPictures({
          provider: sharedLimits().paced(llm, {
            background: true,
            feature: 'pictures',
          }),
          items,
          onUsage: (spent) => {
            usage = addLlmUsage(usage, spent);
          },
        });
      } finally {
        // A later batch or redraw can fail after earlier calls have already cost tokens.
        // Registry errors are logged through the same callback as other background errors,
        // but must not discard completed pictures or replace the original drawing error.
        await registry
          .touch(key.docId, registryLlmUsage(usage))
          .catch((error: unknown) => onError?.(error, now() - started));
      }
      if (drawn.stoppedReason) {
        if (perBrief) {
          // Records only for briefs that did get a picture: the others were never decided.
          await Promise.all(
            items
              .filter((item) =>
                drawn.entries.some((e) => e.item === item.index),
              )
              .map((item) =>
                cache.put(
                  briefKey(key.docId, llm, item),
                  drawn.entries.filter((e) => e.item === item.index),
                ),
              ),
          );
        } else {
          // Pictures already drawn are never replaced by fewer.
          const kept = stopped.get(name)?.entries ?? [];
          stopped.set(name, {
            at: now(),
            entries: drawn.entries.length >= kept.length ? drawn.entries : kept,
          });
        }
        // Throwing keeps getOrCompute from storing a partial set as the finished one.
        throw new AppError('BUDGET_EXHAUSTED');
      }
      options.log?.({
        event: 'pictures_made',
        source: key.source,
        count: drawn.entries.length,
        recovered: drawn.recovered,
      });
      if (drawn.dropped.length > 0 || drawn.retried > 0)
        options.log?.({
          event: 'pictures_dropped',
          source: key.source,
          count: drawn.dropped.length,
          retried: drawn.retried,
        });
      // Full coverage: remember each brief's own result (an empty one too, so a refused
      // picture is not asked for again), so a later grouping never redraws it.
      if (perBrief)
        await Promise.all(
          items.map((item) =>
            cache.put(
              briefKey(key.docId, llm, item),
              drawn.entries.filter((e) => e.item === item.index),
            ),
          ),
        );
      return drawn.entries;
    };
    // Per-brief records are the cache then; a batch-level hit could skip writing them.
    return (perBrief ? compute() : cache.getOrCompute(key, compute))
      .then(() => undefined)
      .catch((error: unknown) => {
        failedAt.set(name, now());
        // A spent job budget ends drawing for this document; nothing else is started for it.
        if (isBudgetExhausted(error)) {
          budgetStoppedAt.set(key.docId, now());
          options.breakdown.reportPicturesStopped?.(key.docId);
        }
        onError?.(error, now() - started);
      })
      .finally(() => {
        const waiters = running.get(name);
        running.delete(name);
        for (const finish of waiters ?? []) finish();
      });
  }

  /**
   * Full coverage (#382): a picture is remembered per brief, keyed by its part and caption text,
   * so it is found again however the briefs are later grouped (a resume can add a part that had
   * no brief at first, which moves every later brief into a different group). Groups only
   * batch the briefs that have no record yet, ten to a model call.
   */
  const briefKey = (
    docId: string,
    llm: LlmProvider,
    item: PictureItem,
  ): PictureCacheKey => ({
    docId,
    source: 'breakdown',
    sourceHash: pictureSourceHash([item]),
    provider: llm.id,
    model: llm.model,
    promptVersion: PICTURE_PROMPT_VERSION,
  });
  /** Records are immutable once written, so a found one is remembered for later looks. */
  const known = new LruMap<PictureEntry[]>(options.knownLimit ?? KNOWN_RECORDS);

  async function briefState(
    docId: string,
    llm: LlmProvider,
    items: readonly PictureItem[],
    complete: boolean,
  ): Promise<{
    entries: PictureEntry[];
    batches: { key: PictureCacheKey; name: string; items: PictureItem[] }[];
  }> {
    const entries: PictureEntry[] = [];
    const missing: PictureItem[] = [];
    // A document that was removed or evicted takes its remembered records with it.
    const registered = await Promise.resolve()
      .then(() => registry.isRegistered(docId))
      .catch(() => true);
    if (!registered) known.deletePrefix(`${docId}:`);
    for (const item of items) {
      const key = briefKey(docId, llm, item);
      const id = `${docId}:${pictureCacheHash(key)}`;
      const hit = known.get(id) ?? (await cache.get(key));
      if (hit) {
        if (registered) known.set(id, hit);
        // The record may have been made when the brief sat at another position.
        entries.push(...hit.map((e) => ({ ...e, item: item.index })));
      } else missing.push(item);
    }
    const batches = [];
    for (let i = 0; i < missing.length; i += ITEMS_PER_CALL) {
      const chunk = missing.slice(i, i + ITEMS_PER_CALL);
      // A short last batch is final only once the breakdown is.
      if (!complete && chunk.length < ITEMS_PER_CALL) break;
      const [first] = chunk;
      if (!first) break;
      const key: PictureCacheKey = {
        ...briefKey(docId, llm, first),
        sourceHash: pictureSourceHash(chunk),
      };
      batches.push({
        key,
        name: `${docId}:${pictureCacheHash(key)}`,
        items: chunk,
      });
    }
    return { entries, batches };
  }

  async function stillMissing(
    docId: string,
    llm: LlmProvider,
    items: readonly PictureItem[],
  ): Promise<PictureItem[]> {
    const left: PictureItem[] = [];
    for (const item of items) {
      const key = briefKey(docId, llm, item);
      const id = `${docId}:${pictureCacheHash(key)}`;
      if (!known.get(id) && !(await cache.get(key))) left.push(item);
    }
    return left;
  }

  const isCooling = (name: string): boolean => {
    const failed = failedAt.get(name);
    return failed !== undefined && now() - failed < FAILED_RETRY_MS;
  };

  /**
   * Background drawing (#382): under full coverage the server draws the finished briefs without
   * waiting for a reader. A batch finishing in the breakdown calls this; one drain runs per
   * document, picks up briefs that appeared meanwhile, draws one batch at a time (paced as
   * background work), and ends when nothing is left, a batch is cooling down after a failure
   * (a repeated notice never retries it early) or the job budget is spent. The poll path stays
   * the same: it serves the cache or joins whatever draw is in flight.
   */
  const draining = new Set<string>();
  const drainAgain = new Set<string>();
  async function drainBackground(docId: string): Promise<void> {
    if (options.publicMode || !options.breakdown.progressivePictures) return;
    if (draining.has(docId)) {
      drainAgain.add(docId);
      return;
    }
    draining.add(docId);
    try {
      const llm = provider();
      if (!llm) return;
      const tried = new Set<string>();
      do {
        drainAgain.delete(docId);
        for (;;) {
          const found = await sourceItems(docId, 'breakdown');
          if (found.status !== 'ready') break;
          const stoppedAt = budgetStoppedAt.get(docId);
          if (stoppedAt !== undefined && now() - stoppedAt < FAILED_RETRY_MS)
            return;
          const { batches } = await briefState(
            docId,
            llm,
            found.items,
            found.complete,
          );
          const next = batches.find(
            (batch) => !tried.has(batch.name) && !isCooling(batch.name),
          );
          if (!next) break;
          // One draw at a time per document, whoever asked for it: join the one in flight, then
          // look again, since it may have drawn these briefs.
          const busy = [...running].find(([name]) =>
            name.startsWith(`${docId}:`),
          );
          if (busy) {
            await waitForSummary(busy[1], 120_000);
            continue;
          }
          tried.add(next.name);
          await start(next.key, next.name, llm, next.items, undefined, true);
        }
      } while (drainAgain.has(docId));
    } catch {
      // Pictures are an enhancement: a failure here must never reach the breakdown.
    } finally {
      draining.delete(docId);
    }
  }
  options.breakdown.subscribe?.((docId) => {
    void drainBackground(docId);
  });

  /**
   * Full coverage (#382): the answer to a look. Records found per brief are returned; the first
   * batch without one is started (one at a time per document, each look starting the next);
   * the client attaches a picture only when its text matches the brief's.
   */
  async function getByGroup(
    docId: string,
    llm: LlmProvider,
    items: readonly PictureItem[],
    complete: boolean,
    request: PictureRequestOptions,
    waited = false,
  ): Promise<PicturesResponse> {
    const { entries, batches } = await briefState(docId, llm, items, complete);
    const finish = (more: boolean): PicturesResponse => {
      if (more)
        return entries.length > 0
          ? { status: 'pending', entries }
          : { status: 'pending' };
      return respond(entries);
    };
    if (options.publicMode)
      return entries.length > 0 ? respond(entries) : { status: 'disabled' };

    const stoppedAt = budgetStoppedAt.get(docId);
    const budgetStopped =
      stoppedAt !== undefined && now() - stoppedAt < FAILED_RETRY_MS;
    // Briefs still to come keep the reader polling; so does a batch being drawn or about to be.
    const todo = budgetStopped ? [] : batches.filter((b) => !isCooling(b.name));
    const more = !complete ? !budgetStopped : todo.length > 0;
    if (todo.length === 0) return finish(more);

    const busy = [...running].find(([name]) => name.startsWith(`${docId}:`));
    if (busy) {
      if (request.wait !== false && !waited) {
        await waitForSummary(busy[1], options.waitMs ?? 20_000, request.signal);
        if (!request.signal?.aborted)
          return getByGroup(docId, llm, items, complete, request, true);
      }
      return finish(true);
    }
    const next = todo[0];
    if (next)
      void start(next.key, next.name, llm, next.items, request.onError, true);
    return finish(true);
  }

  async function get(
    docId: string,
    source: PictureSource,
    request: PictureRequestOptions = {},
  ): Promise<PicturesResponse> {
    const llm = provider();
    if (!llm) return { status: 'disabled' };
    const found = await sourceItems(docId, source);
    if (found.status === 'pending') return { status: 'pending' };
    if (found.status !== 'ready') return { status: found.status };

    const key: PictureCacheKey = {
      docId,
      source,
      sourceHash: pictureSourceHash(found.items),
      provider: llm.id,
      model: llm.model,
      promptVersion: PICTURE_PROMPT_VERSION,
    };
    if (source === 'breakdown' && options.breakdown.progressivePictures)
      return getByGroup(docId, llm, found.items, found.complete, request);
    const hit = await cache.get(key);
    if (hit) return respond(hit);
    // Public mode serves cache hits only: an anonymous visitor never spends the host's money.
    if (options.publicMode) return { status: 'disabled' };

    const name = `${docId}:${pictureCacheHash(key)}`;
    const inFlight = running.get(name);
    if (inFlight) {
      if (request.wait !== false)
        await waitForSummary(
          inFlight,
          options.waitMs ?? 20_000,
          request.signal,
        );
      const done = request.signal?.aborted ? undefined : await cache.get(key);
      return done ? respond(done) : { status: 'pending' };
    }
    if (request.start === false) return { status: 'pending' };
    const halted = stopped.get(name);
    if (halted && !(budgetRemaining() && now() - halted.at >= FAILED_RETRY_MS))
      return respond(halted.entries);
    const failed = failedAt.get(name);
    if (failed !== undefined && now() - failed < FAILED_RETRY_MS)
      return { status: 'none' };
    failedAt.delete(name);
    void start(key, name, llm, found.items, request.onError);
    return { status: 'pending' };
  }

  function resume(docId: string): void {
    for (const name of [...failedAt.keys()])
      if (name.startsWith(`${docId}:`)) failedAt.delete(name);
    for (const [name, halted] of stopped)
      if (name.startsWith(`${docId}:`)) halted.at = Number.NEGATIVE_INFINITY;
    // Full coverage: a paid-for document draws what is left, starting now.
    if (budgetStoppedAt.delete(docId)) void drainBackground(docId);
  }

  return { get, resume, knownRecords: () => known.size };
}
