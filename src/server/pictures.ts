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
import type { LlmUsage } from '../core/model/index.js';
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
import { isBudgetExhausted } from '../core/breakdown/coverage.js';
import { drawPictures, type DrawnPictures } from '../core/picture/generate.js';
import {
  ITEMS_PER_CALL,
  PICTURE_PROMPT_VERSION,
  type PictureItem,
} from '../core/picture/prompt.js';
import { sharedLimits } from '../core/pipeline/limits.js';
import type { BreakdownService } from './breakdown.js';
import {
  FAILED_RETRY_MS,
  waitForSummary,
  type SummaryService,
} from './summary.js';

export interface PictureRequestOptions {
  /** False answers at once (HEAD, tests); default waits up to `waitMs` for a run in progress. */
  wait?: boolean;
  signal?: AbortSignal;
  onError?: (error: unknown, ms: number) => void;
}

export interface PictureService {
  get(
    docId: string,
    source: PictureSource,
    request?: PictureRequestOptions,
  ): Promise<PicturesResponse>;
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
  ): void {
    const started = now();
    // Forget cool-downs that are over, so the map holds only recent failures.
    for (const [other, at] of failedAt)
      if (started - at >= FAILED_RETRY_MS) failedAt.delete(other);
    running.set(name, new Set());
    void cache
      .getOrCompute(key, async () => {
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
        return drawn.entries;
      })
      .catch((error: unknown) => {
        failedAt.set(name, now());
        // A spent job budget ends drawing for this document; nothing else is started for it.
        if (isBudgetExhausted(error)) budgetStoppedAt.set(key.docId, now());
        onError?.(error, now() - started);
      })
      .finally(() => {
        const waiters = running.get(name);
        running.delete(name);
        for (const finish of waiters ?? []) finish();
      });
  }

  /**
   * Full coverage (#382): pictures for a breakdown are drawn and cached in fixed groups of
   * `ITEMS_PER_CALL` briefs (one model call each), so a group that is finished is never drawn
   * again when more briefs arrive. Briefs only ever append in document order, so a group's
   * contents, and therefore its cache key, do not change once it is full. The client attaches a
   * picture only when its text matches the brief's, so a stale entry can never mislabel one.
   * Groups are drawn one at a time per document, each look starting the next one.
   */
  async function getByGroup(
    docId: string,
    llm: LlmProvider,
    items: readonly PictureItem[],
    complete: boolean,
    request: PictureRequestOptions,
    waited = false,
  ): Promise<PicturesResponse> {
    const groups: PictureItem[][] = [];
    for (let i = 0; i < items.length; i += ITEMS_PER_CALL)
      groups.push(items.slice(i, i + ITEMS_PER_CALL));
    // A short last group is final only once the breakdown is.
    const ready = complete
      ? groups
      : groups.filter((g) => g.length === ITEMS_PER_CALL);

    const entries: PictureEntry[] = [];
    const missing: {
      key: PictureCacheKey;
      name: string;
      items: PictureItem[];
    }[] = [];
    for (const group of ready) {
      const key: PictureCacheKey = {
        docId,
        source: 'breakdown',
        sourceHash: pictureSourceHash(group),
        provider: llm.id,
        model: llm.model,
        promptVersion: PICTURE_PROMPT_VERSION,
      };
      const hit = await cache.get(key);
      if (hit) entries.push(...hit);
      else
        missing.push({
          key,
          name: `${docId}:${pictureCacheHash(key)}`,
          items: group,
        });
    }
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
    const cooling = (name: string): boolean => {
      const failed = failedAt.get(name);
      return failed !== undefined && now() - failed < FAILED_RETRY_MS;
    };
    // Briefs still to come keep the reader polling; so does a group being drawn or about to be.
    const todo = budgetStopped ? [] : missing.filter((m) => !cooling(m.name));
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
    if (next) start(next.key, next.name, llm, next.items, request.onError);
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
    const failed = failedAt.get(name);
    if (failed !== undefined && now() - failed < FAILED_RETRY_MS)
      return { status: 'none' };
    failedAt.delete(name);
    start(key, name, llm, found.items, request.onError);
    return { status: 'pending' };
  }

  return { get };
}
