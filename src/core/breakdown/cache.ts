/**
 * Disk cache for the finished "Section by section" briefs. It sits beside the answer cache, in
 * the same per-document directory (so removing or evicting a document deletes it too), with its
 * own file format: the answer cache stores only `AnswerResult`s, and the contract's chip ids are
 * frozen, so a breakdown cannot ride in it as a chip.
 *
 * The key follows ADR 0008 + 0015: provider, model, endpoint, this feature's prompt version and
 * the context mode (plus the whole-bill prompt version in whole mode) are all part of identity.
 * Only complete, non-empty results are stored; a failed or empty run is never cached.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { documentIo, evictionCount } from '../answer-cache.js';
import { WHOLE_PROMPT_VERSION } from '../answer/prompt.js';
import {
  configFileSystem,
  readPrivateJson,
  writePrivateJson,
  type ConfigFileSystem,
} from '../config-files.js';
import { NormalizedDoc, SectionBrief } from '../model/index.js';

export interface BreakdownCacheKey {
  docId: string;
  provider: string;
  model: string;
  endpoint: string;
  promptVersion: string;
  context: 'whole' | 'excerpts';
  /**
   * Full coverage (#382): the cap on briefed parts when it is not the default of 30. A different
   * cap briefs different parts, so it is part of identity; the default leaves existing keys as
   * they were.
   */
  unitCap?: number | 'all' | undefined;
}

const StoredBreakdown = z.object({
  briefs: z.array(SectionBrief).min(1),
  omitted: z.number().int().nonnegative(),
  context: z.enum(['whole', 'excerpts']),
  provider: z.string(),
  model: z.string(),
});
export type StoredBreakdown = z.infer<typeof StoredBreakdown>;

/**
 * A run in progress (#382): the briefs of every finished batch, written after each batch so a
 * reader sees them as they arrive and a run that stopped (a budget, a restart) resumes with them.
 * Replaced by the full result when the run completes.
 */
const PartialBreakdown = z.object({
  briefs: z.array(SectionBrief),
  /** Parts of the bill this run will brief when it finishes. */
  total: z.number().int().nonnegative(),
  /** Parts given up on so far in the run that wrote this. */
  dropped: z.number().int().nonnegative(),
  omitted: z.number().int().nonnegative(),
  context: z.enum(['whole', 'excerpts']),
  provider: z.string(),
  model: z.string(),
});
export type PartialBreakdown = z.infer<typeof PartialBreakdown>;

/** sha256 over a JSON tuple, so no separator character can make two keys collide. */
export function breakdownCacheHash(key: BreakdownCacheKey): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'breakdown',
        provider: key.provider,
        model: key.model,
        endpoint: key.endpoint,
        promptVersion: key.promptVersion,
        context: key.context,
        whole: key.context === 'whole' ? WHOLE_PROMPT_VERSION : null,
        ...(key.unitCap === undefined ? {} : { unitCap: key.unitCap }),
      }),
    )
    .digest('hex');
}

export interface BreakdownCacheOptions {
  /** The answer cache directory, normally <configDir>/cache/answers. */
  dir: string;
  fs?: ConfigFileSystem;
  /** Prevents writing for a document removed while the breakdown was being generated. */
  isStillRegistered?: (docId: string) => boolean | Promise<boolean>;
  /** Told when the final write fails (never the message, which may hold a path). */
  onWriteError?: (error: unknown) => void;
}

// In-process de-duplication of concurrent identical runs.
const flights = new Map<string, Promise<StoredBreakdown | undefined>>();

export class BreakdownCache {
  private readonly dir: string;
  private readonly fs: ConfigFileSystem;
  private readonly isStillRegistered: BreakdownCacheOptions['isStillRegistered'];

  private readonly onWriteError: (error: unknown) => void;

  constructor(options: BreakdownCacheOptions) {
    this.onWriteError =
      options.onWriteError ??
      ((error) => {
        const code =
          typeof error === 'object' && error !== null && 'code' in error
            ? String(error.code)
            : 'unknown';
        console.error(
          `breakdown cache: final write failed (${code}); kept the checkpoint`,
        );
      });
    this.dir = resolve(options.dir);
    this.fs = options.fs ?? configFileSystem;
    this.isStillRegistered = options.isStillRegistered;
  }

  private path(key: BreakdownCacheKey): string {
    // The same check the answer cache applies, so a hostile id can never escape the directory.
    if (!NormalizedDoc.shape.docId.safeParse(key.docId).success)
      throw new Error('Invalid breakdown cache document id.');
    return join(
      this.dir,
      key.docId,
      `breakdown-${breakdownCacheHash(key)}.json`,
    );
  }

  private partialPath(key: BreakdownCacheKey): string {
    if (!NormalizedDoc.shape.docId.safeParse(key.docId).success)
      throw new Error('Invalid breakdown cache document id.');
    return join(
      this.dir,
      key.docId,
      `breakdown-partial-${breakdownCacheHash(key)}.json`,
    );
  }

  /** The unfinished run's briefs, or `undefined`. Never trusted across providers or models. */
  async getPartial(
    key: BreakdownCacheKey,
  ): Promise<PartialBreakdown | undefined> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.partialPath(key), this.fs);
    } catch {
      return undefined;
    }
    const parsed = PartialBreakdown.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.provider !== key.provider ||
      parsed.data.model !== key.model
    )
      return undefined;
    return parsed.data;
  }

  /** Same guards as `store`; a write that loses the race with an eviction is dropped. */
  private storePartial(
    key: BreakdownCacheKey,
    partial: PartialBreakdown,
    startedAt: number,
  ): Promise<void> {
    const path = this.partialPath(key);
    const documentPath = join(this.dir, key.docId);
    return documentIo(documentPath, async () => {
      if (evictionCount(documentPath) !== startedAt) return;
      if (this.isStillRegistered && !(await this.isStillRegistered(key.docId)))
        return;
      await writePrivateJson(path, partial, this.fs);
    });
  }

  /** A miss is `undefined`: absent, unreadable, corrupt, or written by another provider or model. */
  async get(key: BreakdownCacheKey): Promise<StoredBreakdown | undefined> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.path(key), this.fs);
    } catch {
      return undefined;
    }
    const parsed = StoredBreakdown.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.provider !== key.provider ||
      parsed.data.model !== key.model
    )
      return undefined;
    return parsed.data;
  }

  /** Writes under the per-document lock, unless the document was evicted since `startedAt`. */
  private store(
    key: BreakdownCacheKey,
    result: StoredBreakdown,
    startedAt: number,
  ): Promise<void> {
    const path = this.path(key);
    const documentPath = join(this.dir, key.docId);
    return documentIo(documentPath, async () => {
      if (evictionCount(documentPath) !== startedAt) return;
      if (this.isStillRegistered && !(await this.isStillRegistered(key.docId)))
        return;
      await writePrivateJson(path, result, this.fs);
    });
  }

  private removePartial(key: BreakdownCacheKey): Promise<void> {
    const path = this.partialPath(key);
    return documentIo(join(this.dir, key.docId), async () => {
      await this.fs.unlink(path).catch(() => undefined);
    });
  }

  /**
   * Cached result, or the one in-flight computation shared by concurrent callers. `compute`
   * returns `undefined` for a run that produced nothing worth keeping; that is not stored.
   */
  getOrCompute(
    key: BreakdownCacheKey,
    compute: (
      checkpoint: (partial: PartialBreakdown) => Promise<void>,
    ) => Promise<StoredBreakdown | undefined>,
  ): Promise<StoredBreakdown | undefined> {
    const path = this.path(key);
    const existing = flights.get(path);
    if (existing) return existing;
    const startedAt = evictionCount(join(this.dir, key.docId));
    const flight = Promise.resolve()
      .then(async () => {
        const hit = await this.get(key);
        if (hit) return hit;
        // A failure to checkpoint costs the reader an early view, never the run.
        const result = await compute((partial) =>
          this.storePartial(key, partial, startedAt).catch(() => undefined),
        );
        if (result && result.briefs.length > 0) {
          // The checkpoint goes only once the final result is safely written; if that write
          // fails, the finished batches stay on disk for the next run to resume from.
          const written = await this.store(key, result, startedAt).then(
            () => true,
            (error: unknown) => {
              this.onWriteError(error);
              return false;
            },
          );
          if (written) await this.removePartial(key).catch(() => undefined);
        }
        return result;
      })
      .finally(() => {
        if (flights.get(path) === flight) flights.delete(path);
      });
    flights.set(path, flight);
    return flight;
  }
}
