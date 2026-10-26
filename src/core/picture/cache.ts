/**
 * Cache for drawn pictures (#344). It sits beside the answer cache in the per-document directory,
 * so removing or evicting a document deletes its pictures too, with its own key and file format.
 *
 * The key includes a hash of the source text (the summary, or the briefs), so a regenerated
 * summary gets new pictures and an old picture can never be served for new words. An empty result
 * (nothing could be drawn honestly) is cached as well; failures are not, the service backs off.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { documentIo, evictionCount } from '../answer-cache.js';
import {
  configFileSystem,
  readPrivateJson,
  writePrivateJson,
  type ConfigFileSystem,
} from '../config-files.js';
import { NormalizedDoc, PictureEntry } from '../model/index.js';

export type PictureSource = 'summary' | 'breakdown';

export interface PictureCacheKey {
  docId: string;
  source: PictureSource;
  /** sha256 of the source text the pictures were drawn from. */
  sourceHash: string;
  provider: string;
  model: string;
  promptVersion: string;
}

const StoredPictures = z.object({
  entries: z.array(PictureEntry),
  provider: z.string(),
  model: z.string(),
  storedAt: z.number(),
});

/** sha256 over a JSON tuple, so no separator character can make two keys collide. */
export function pictureCacheHash(key: PictureCacheKey): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'pictures',
        source: key.source,
        sourceHash: key.sourceHash,
        provider: key.provider,
        model: key.model,
        promptVersion: key.promptVersion,
      }),
    )
    .digest('hex');
}

/** The hash of what pictures are drawn from: the items' texts (and parts) in order. */
export function pictureSourceHash(
  items: readonly { text: string; sectionId?: string }[],
): string {
  return createHash('sha256')
    .update(JSON.stringify(items.map((i) => [i.sectionId ?? '', i.text])))
    .digest('hex');
}

export interface PictureCacheOptions {
  /** The answer cache directory, normally <configDir>/cache/answers. */
  dir: string;
  fs?: ConfigFileSystem;
  now?: () => number;
  /** Prevents writing for a document removed while its pictures were being drawn. */
  isStillRegistered?: (docId: string) => boolean | Promise<boolean>;
}

// In-process de-duplication of concurrent identical runs.
const flights = new Map<string, Promise<PictureEntry[]>>();

export class PictureCache {
  private readonly dir: string;
  private readonly fs: ConfigFileSystem;
  private readonly now: () => number;
  private readonly isStillRegistered: PictureCacheOptions['isStillRegistered'];

  constructor(options: PictureCacheOptions) {
    this.dir = resolve(options.dir);
    this.fs = options.fs ?? configFileSystem;
    this.now = options.now ?? Date.now;
    this.isStillRegistered = options.isStillRegistered;
  }

  private path(key: PictureCacheKey): string {
    // The same check the answer cache applies, so a hostile id can never escape the directory.
    if (!NormalizedDoc.shape.docId.safeParse(key.docId).success)
      throw new Error('Invalid picture cache document id.');
    return join(this.dir, key.docId, `pictures-${pictureCacheHash(key)}.json`);
  }

  /** The stored entries (possibly empty), or `undefined` on a miss or an unreadable file. */
  async get(key: PictureCacheKey): Promise<PictureEntry[] | undefined> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.path(key), this.fs);
    } catch {
      return undefined;
    }
    const parsed = StoredPictures.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.provider !== key.provider ||
      parsed.data.model !== key.model
    )
      return undefined;
    return parsed.data.entries;
  }

  /**
   * Writes under the per-document lock eviction uses, and only if no eviction happened since the
   * run began (see ScenarioCache.store for why both are needed).
   */
  private store(
    key: PictureCacheKey,
    entries: PictureEntry[],
    startedAt: number,
  ): Promise<void> {
    const path = this.path(key);
    const documentPath = join(this.dir, key.docId);
    return documentIo(documentPath, async () => {
      if (evictionCount(documentPath) !== startedAt) return;
      if (this.isStillRegistered && !(await this.isStillRegistered(key.docId)))
        return;
      await writePrivateJson(
        path,
        {
          entries,
          provider: key.provider,
          model: key.model,
          storedAt: this.now(),
        },
        this.fs,
      );
    });
  }

  /** Cached entries, or the one in-flight run shared by concurrent callers. */
  getOrCompute(
    key: PictureCacheKey,
    compute: () => Promise<PictureEntry[]>,
  ): Promise<PictureEntry[]> {
    const path = this.path(key);
    const existing = flights.get(path);
    if (existing) return existing;
    const startedAt = evictionCount(join(this.dir, key.docId));
    const flight = Promise.resolve()
      .then(async () => {
        const hit = await this.get(key);
        if (hit) return hit;
        const entries = await compute();
        // A storage failure never discards pictures that were already paid for.
        await this.store(key, entries, startedAt).catch(() => undefined);
        return entries;
      })
      .finally(() => {
        if (flights.get(path) === flight) flights.delete(path);
      });
    flights.set(path, flight);
    return flight;
  }
}
