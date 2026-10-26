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
import { drawPictures } from '../core/picture/generate.js';
import {
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

type SourceItems =
  | { status: 'ready'; items: PictureItem[] }
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
      const summary = await options.summary.get(docId, { wait: false });
      if (summary.status !== 'cached' || !summary.answer)
        return { status: summary.status === 'pending' ? 'pending' : 'none' };
      const items = listItems(summary.answer.text);
      return items.length > 0 ? { status: 'ready', items } : { status: 'none' };
    }
    const breakdown = await options.breakdown
      .get(docId, { wait: false })
      // A breakdown that is cooling down after a failure has nothing to draw yet.
      .catch(() => ({ status: 'disabled' as const, briefs: undefined }));
    if (breakdown.status === 'pending') return { status: 'pending' };
    if (breakdown.status !== 'cached' || !breakdown.briefs?.length)
      return { status: 'none' };
    return {
      status: 'ready',
      items: breakdown.briefs.map((brief, index) => ({
        index,
        text: brief.text,
        sectionId: brief.sectionId,
      })),
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
    running.set(name, new Set());
    void cache
      .getOrCompute(key, async () => {
        // Nobody waits on this; it yields to readers' own questions (`Limits.paced`).
        const drawn = await drawPictures({
          provider: sharedLimits().paced(llm, { background: true }),
          items,
        });
        options.log?.({
          event: 'pictures_made',
          source: key.source,
          count: drawn.entries.length,
        });
        if (drawn.dropped.length > 0)
          options.log?.({
            event: 'pictures_dropped',
            source: key.source,
            count: drawn.dropped.length,
          });
        return drawn.entries;
      })
      .catch((error: unknown) => {
        failedAt.set(name, now());
        onError?.(error, now() - started);
      })
      .finally(() => {
        const waiters = running.get(name);
        running.delete(name);
        for (const finish of waiters ?? []) finish();
      });
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
