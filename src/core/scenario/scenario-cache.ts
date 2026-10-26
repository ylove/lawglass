/**
 * Cache for reader-requested scenarios. It lives beside the answer cache, in the same
 * per-document directory, so removing or evicting a document deletes it too, but it has its own
 * key and file format: the answer cache stores only `AnswerResult`s.
 *
 * `none` (a scenario the model could not ground) is cached too, with a cool-down, so repeating
 * the same request does not pay for the same failed generation again and again.
 */
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  configFileSystem,
  readPrivateJson,
  writePrivateJson,
  type ConfigFileSystem,
} from '../config-files.js';
import { documentIo, evictionCount } from '../answer-cache.js';
import { NormalizedDoc, Scenario } from '../model/index.js';
import { normalizeSubject } from './generate.js';

/** How long a `none` result is served before the same request may try again. */
export const NONE_RETRY_MS = 10 * 60_000;

export interface ScenarioCacheKey {
  docId: string;
  /** The reader's subject; empty for a per-section example, which is keyed by `sectionId`. */
  subject: string;
  /** A per-section example (#277): one cached result per part of the bill, never shared. */
  sectionId?: string;
  provider: string;
  model: string;
  promptVersion: string;
}

const StoredScenario = z.object({
  status: z.enum(['ok', 'none']),
  scenario: Scenario.optional(),
  provider: z.string(),
  model: z.string(),
  /** Epoch milliseconds when this was stored; the cool-down counts from it. */
  storedAt: z.number(),
});

/** sha256 over a JSON tuple, so no separator character can make two keys collide. */
export function scenarioCacheHash(key: ScenarioCacheKey): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        kind: 'scenario',
        subjectNorm: normalizeSubject(key.subject),
        // Added only when set, so every existing subject-scenario hash is unchanged. Not
        // lowercased: section ids are case-sensitive.
        ...(key.sectionId === undefined ? {} : { sectionId: key.sectionId }),
        provider: key.provider,
        model: key.model,
        promptVersion: key.promptVersion,
      }),
    )
    .digest('hex');
}

export interface ScenarioCacheOptions {
  /** The answer cache directory, normally <configDir>/cache/answers. */
  dir: string;
  fs?: ConfigFileSystem;
  now?: () => number;
  /** Prevents writing for a document removed while the scenario was being generated. */
  isStillRegistered?: (docId: string) => boolean | Promise<boolean>;
}

export type ScenarioLookup =
  { status: 'ok'; scenario: Scenario } | { status: 'none' } | undefined;

// In-process de-duplication of concurrent identical requests.
const flights = new Map<string, Promise<NonNullable<ScenarioLookup>>>();

export class ScenarioCache {
  private readonly dir: string;
  private readonly fs: ConfigFileSystem;
  private readonly now: () => number;
  private readonly isStillRegistered: ScenarioCacheOptions['isStillRegistered'];

  constructor(options: ScenarioCacheOptions) {
    this.dir = resolve(options.dir);
    this.fs = options.fs ?? configFileSystem;
    this.now = options.now ?? Date.now;
    this.isStillRegistered = options.isStillRegistered;
  }

  private path(key: ScenarioCacheKey): string {
    // The same check the answer cache applies, so a hostile id can never escape the directory.
    if (!NormalizedDoc.shape.docId.safeParse(key.docId).success)
      throw new Error('Invalid scenario cache document id.');
    return join(this.dir, key.docId, `scenario-${scenarioCacheHash(key)}.json`);
  }

  /** A miss is `undefined`: absent, unreadable, corrupt, another model, or a `none` past its cool-down. */
  async get(key: ScenarioCacheKey): Promise<ScenarioLookup> {
    let value: unknown;
    try {
      value = await readPrivateJson(this.path(key), this.fs);
    } catch {
      return undefined;
    }
    const parsed = StoredScenario.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.provider !== key.provider ||
      parsed.data.model !== key.model
    )
      return undefined;
    const { status, scenario, storedAt } = parsed.data;
    if (status === 'none')
      return this.now() - storedAt < NONE_RETRY_MS
        ? { status: 'none' }
        : undefined;
    return scenario ? { status: 'ok', scenario } : undefined;
  }

  /**
   * Writes under the same per-document lock eviction uses, and only if no eviction happened since
   * `startedAt` (the eviction count when generation began). Either alone is not enough: removal
   * deletes the directory before the registry forgets the document, so a write that waited for
   * the lock would still find the document registered and recreate its file.
   */
  private store(
    key: ScenarioCacheKey,
    result: NonNullable<ScenarioLookup>,
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
          status: result.status,
          ...(result.status === 'ok' ? { scenario: result.scenario } : {}),
          provider: key.provider,
          model: key.model,
          storedAt: this.now(),
        },
        this.fs,
      );
    });
  }

  /**
   * Cached result, or the one in-flight computation shared by concurrent callers. A storage
   * failure never discards a result that was already paid for.
   */
  getOrCompute(
    key: ScenarioCacheKey,
    compute: () => Promise<NonNullable<ScenarioLookup>>,
  ): Promise<NonNullable<ScenarioLookup>> {
    const path = this.path(key);
    const existing = flights.get(path);
    if (existing) return existing;
    const startedAt = evictionCount(join(this.dir, key.docId));
    const flight = Promise.resolve()
      .then(async () => {
        const hit = await this.get(key);
        if (hit) return hit;
        const result = await compute();
        await this.store(key, result, startedAt).catch(() => undefined);
        return result;
      })
      .finally(() => {
        if (flights.get(path) === flight) flights.delete(path);
      });
    flights.set(path, flight);
    return flight;
  }
}
