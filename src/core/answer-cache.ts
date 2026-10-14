import { createHash } from 'node:crypto';
import * as nodeFs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AnswerResult, ChipId, NormalizedDoc } from './model/index.js';
import {
  configFileSystem,
  readPrivateJson,
  storageError,
  writePrivateJson,
  type ConfigFileSystem,
} from './config-files.js';

// A separator in a component would make two different tuples hash to the same key.
const component = z
  .string()
  .min(1)
  .refine((value) => !value.includes('|'));
const Key = z.object({
  docId: NormalizedDoc.shape.docId,
  chipId: ChipId,
  provider: component,
  model: component,
  promptVersion: component,
});
export type AnswerCacheKey = z.infer<typeof Key>;

function validatedKey(key: AnswerCacheKey): AnswerCacheKey {
  const parsed = Key.safeParse(key);
  if (!parsed.success) throw storageError('Invalid answer cache key.');
  return parsed.data;
}

/** sha256(docId|chipId|provider|model|promptVersion), per ADR 0008. */
export function answerCacheKey(key: AnswerCacheKey): string {
  const { docId, chipId, provider, model, promptVersion } = validatedKey(key);
  return createHash('sha256')
    .update([docId, chipId, provider, model, promptVersion].join('|'))
    .digest('hex');
}

export type AnswerCacheFileSystem = ConfigFileSystem &
  Pick<typeof nodeFs, 'rm'>;
export interface AnswerCacheOptions {
  /** Answer directory, normally <configDir>/cache/answers. */
  dir: string;
  fs?: AnswerCacheFileSystem;
  /** Registry wiring can prevent writes for a document removed before generation finishes. */
  isStillRegistered?: (docId: string) => boolean | Promise<boolean>;
}

interface Flight {
  documentPath: string;
  cacheable: boolean;
  promise: Promise<AnswerResult>;
}
// Share state across instances, including the Registry's cache used for eviction. This is
// in-process deduplication; separate CLI/server processes do not share generation promises.
const flights = new Map<string, Flight>();
const pendingIo = new Map<string, Promise<unknown>>();

async function documentIo<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = pendingIo.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  pendingIo.set(path, next);
  try {
    return await next;
  } finally {
    if (pendingIo.get(path) === next) pendingIo.delete(path);
  }
}

function cacheable(answer: AnswerResult): boolean {
  return (
    !answer.declined &&
    !answer.warnings.some(
      (warning) =>
        warning === 'NO_VALID_CITATIONS' ||
        warning === 'TRUNCATED' ||
        warning === 'NO_RELEVANT_EXCERPTS',
    )
  );
}

export class AnswerCache {
  private readonly dir: string;
  private readonly fs: AnswerCacheFileSystem;
  private readonly isStillRegistered: AnswerCacheOptions['isStillRegistered'];

  constructor(options: AnswerCacheOptions) {
    this.dir = resolve(options.dir);
    this.fs = options.fs ?? { ...configFileSystem, rm: nodeFs.rm };
    this.isStillRegistered = options.isStillRegistered;
  }

  private documentPath(docId: string): string {
    if (!NormalizedDoc.shape.docId.safeParse(docId).success)
      throw storageError('Invalid answer cache document id.');
    return join(this.dir, docId);
  }

  private location(key: AnswerCacheKey): {
    documentPath: string;
    path: string;
  } {
    const hash = answerCacheKey(key);
    const documentPath = this.documentPath(key.docId);
    return { documentPath, path: join(documentPath, `${hash}.json`) };
  }

  /** Read-only: public mode can use this without ever starting generation. */
  get(key: AnswerCacheKey): Promise<AnswerResult | undefined> {
    const { documentPath, path } = this.location(key);
    return documentIo(documentPath, async () => {
      let value: unknown;
      try {
        value = await readPrivateJson(path, this.fs);
      } catch {
        // Corruption, unsafe permissions, and unreadable files are all cache misses.
        return undefined;
      }
      const parsed = AnswerResult.safeParse(value);
      if (
        !parsed.success ||
        !cacheable(parsed.data) ||
        parsed.data.provider !== key.provider ||
        parsed.data.model !== key.model
      )
        return undefined;
      return parsed.data;
    });
  }

  set(key: AnswerCacheKey, answer: AnswerResult): Promise<void> {
    return this.store(key, answer);
  }

  private store(
    key: AnswerCacheKey,
    answer: AnswerResult,
    flight?: Flight,
  ): Promise<void> {
    const { documentPath, path } = this.location(key);
    const parsed = AnswerResult.safeParse(answer);
    if (
      !parsed.success ||
      parsed.data.provider !== key.provider ||
      parsed.data.model !== key.model
    )
      throw storageError('Invalid answer cache result.');
    if (!cacheable(parsed.data)) return Promise.resolve();
    return documentIo(documentPath, async () => {
      if (flight && !flight.cacheable) return;
      if (
        flight &&
        this.isStillRegistered &&
        !(await this.isStillRegistered(key.docId))
      )
        return;
      try {
        await this.fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
        await this.fs.chmod(this.dir, 0o700);
      } catch {
        throw storageError('The answer cache directory could not be secured.');
      }
      await writePrivateJson(path, parsed.data, this.fs);
    });
  }

  /** Concurrent callers share generation; storage failures never discard a computed answer. */
  getOrCompute(
    key: AnswerCacheKey,
    compute: () => Promise<AnswerResult>,
  ): Promise<AnswerResult> {
    const { documentPath, path } = this.location(key);
    const existing = flights.get(path);
    if (existing) return existing.promise;
    const flight: Flight = {
      documentPath,
      cacheable: true,
      promise: Promise.resolve()
        .then(async () => {
          const hit = await this.get(key);
          if (hit) return hit;
          const answer = await compute();
          try {
            await this.store(key, answer, flight);
          } catch {
            // The cache is optional. Return the paid result without exposing storage errors.
          }
          return answer;
        })
        .finally(() => {
          if (flights.get(path) === flight) flights.delete(path);
        }),
    };
    flights.set(path, flight);
    return flight.promise;
  }

  /** All chips, models and old prompt versions die with their document. */
  evictDocument(docId: string): Promise<void> {
    const documentPath = this.documentPath(docId);
    for (const [path, flight] of flights) {
      if (flight.documentPath === documentPath) {
        flight.cacheable = false;
        flights.delete(path);
      }
    }
    return documentIo(documentPath, async () => {
      try {
        await this.fs.rm(documentPath, { recursive: true, force: true });
      } catch {
        throw storageError('The cached answers could not be removed.');
      }
    });
  }
}
