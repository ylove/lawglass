import { setTimeout as sleep } from 'node:timers/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { AnswerCache } from './answer-cache.js';
import {
  AppError,
  DocSummary,
  NormalizedDoc,
  type BackendKind,
} from './model/index.js';
import {
  configFileSystem,
  isMissingFile,
  readPrivateJson,
  storageError,
  writePrivateJson,
  type ConfigFileSystem,
} from './config-files.js';

export const RegistryUsage = z
  .object({
    embedTokens: z.number().int().nonnegative(),
    rerankUnits: z.number().int().nonnegative(),
    llmInputTokens: z.number().int().nonnegative(),
    llmOutputTokens: z.number().int().nonnegative(),
  })
  .strict();
export type RegistryUsage = z.infer<typeof RegistryUsage>;
const EMPTY_USAGE: RegistryUsage = {
  embedTokens: 0,
  rerankUnits: 0,
  llmInputTokens: 0,
  llmOutputTokens: 0,
};

export const RegistryEntry = DocSummary.extend({
  docId: NormalizedDoc.shape.docId,
  label: z.string().trim().min(1).max(80),
  sourceUrl: z.url(),
  usage: RegistryUsage,
}).strict();
export type RegistryEntry = z.infer<typeof RegistryEntry>;
const Entries = z.array(RegistryEntry).superRefine((entries, context) => {
  if (
    new Set(entries.map((entry) => entry.docId)).size !== entries.length ||
    new Set(entries.map((entry) => entry.label)).size !== entries.length
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Duplicate document or label.',
    });
  }
});

export interface RegistryOptions {
  fs?: ConfigFileSystem;
  now?: () => Date;
  answerCache?: Pick<AnswerCache, 'evictDocument'>;
}
export interface AddDocumentOptions {
  label: string;
  backend: BackendKind;
  usage?: Partial<RegistryUsage>;
}

// Read/modify/write is serialized in two layers. In-process, a promise chain per path avoids
// pointless lock contention. Across processes, an exclusively created lock file (`wx`) guards the
// critical section; rename keeps readers from ever seeing a partially written JSON file.
const pendingWrites = new Map<string, Promise<unknown>>();
const LOCK_STALE_MS = 10_000;
const LOCK_TIMEOUT_MS = 15_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

export class Registry {
  private readonly fs: ConfigFileSystem;
  private readonly now: () => Date;
  private readonly path: string;
  private readonly lockPath: string;
  private readonly answerCache: Pick<AnswerCache, 'evictDocument'>;

  constructor(
    readonly configDir: string,
    options: RegistryOptions = {},
  ) {
    this.fs = options.fs ?? configFileSystem;
    this.now = options.now ?? (() => new Date());
    this.path = join(configDir, 'registry.json');
    this.lockPath = `${this.path}.lock`;
    this.answerCache =
      options.answerCache ??
      new AnswerCache({
        dir: join(configDir, 'cache', 'answers'),
      });
  }

  private async withFileLock<T>(operation: () => Promise<T>): Promise<T> {
    await this.fs.mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    let delay = 5;
    for (;;) {
      try {
        const handle = await this.fs.open(this.lockPath, 'wx', 0o600);
        await handle.close();
        break;
      } catch (error) {
        if (errorCode(error) !== 'EEXIST')
          throw storageError('The registry lock could not be acquired.');
      }
      // A crashed process leaves its lock behind; break locks older than the stale threshold.
      try {
        if (
          Date.now() - (await this.fs.stat(this.lockPath)).mtimeMs >
          LOCK_STALE_MS
        ) {
          await this.fs.unlink(this.lockPath);
          continue;
        }
      } catch {
        continue; // The holder released it between our open and stat.
      }
      if (Date.now() > deadline)
        throw storageError('The document registry is busy. Try again.');
      await sleep(delay + Math.random() * delay);
      delay = Math.min(delay * 2, 200);
    }
    try {
      return await operation();
    } finally {
      await this.fs.unlink(this.lockPath).catch(() => undefined);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = pendingWrites.get(this.path) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.withFileLock(operation));
    pendingWrites.set(this.path, next);
    try {
      return await next;
    } finally {
      if (pendingWrites.get(this.path) === next)
        pendingWrites.delete(this.path);
    }
  }

  private async readEntries(): Promise<RegistryEntry[]> {
    const value = await readPrivateJson(this.path, this.fs);
    const parsed = Entries.safeParse(value ?? []);
    if (!parsed.success)
      throw storageError('The document registry is invalid.');
    return parsed.data;
  }

  private documentPath(docId: string): string {
    // Only a validated hash reaches the filesystem; labels and prefixes never become paths.
    if (!NormalizedDoc.shape.docId.safeParse(docId).success) {
      throw storageError('Invalid document id. Use the full document hash.');
    }
    return join(this.configDir, 'docs', `${docId}.json`);
  }

  private timestamp(): string {
    const parsed = z.iso.datetime().safeParse(this.now().toISOString());
    if (!parsed.success) throw storageError('Invalid registry timestamp.');
    return parsed.data;
  }

  list(): Promise<RegistryEntry[]> {
    return this.exclusive(() => this.readEntries());
  }

  add(doc: NormalizedDoc, options: AddDocumentOptions): Promise<RegistryEntry> {
    return this.exclusive(async () => {
      const parsedDoc = NormalizedDoc.safeParse(doc);
      if (!parsedDoc.success)
        throw storageError('The normalized document is invalid.');
      const normalized = parsedDoc.data;
      const timestamp = this.timestamp();
      const parsedEntry = RegistryEntry.safeParse({
        docId: normalized.docId,
        label: options.label,
        sourceUrl: normalized.sourceUrl,
        format: normalized.format,
        title: normalized.metadata.title,
        billNumber: normalized.metadata.billNumber,
        backend: options.backend,
        ingestedAt: timestamp,
        lastUsedAt: timestamp,
        usage: { ...EMPTY_USAGE, ...options.usage },
      });
      if (!parsedEntry.success)
        throw storageError('Invalid document label, backend, or usage.');
      const entries = await this.readEntries();
      const existing = entries.find(
        (entry) => entry.docId === normalized.docId,
      );
      if (existing) return existing; // Re-ingest is a no-op; never count tokens twice.
      const entry = parsedEntry.data;
      if (entries.some((item) => item.label === entry.label)) {
        throw storageError(
          'That document label is already in use. Choose a different label.',
        );
      }
      // Publish the document before its entry so an entry never points to an unwritten document.
      await writePrivateJson(
        this.documentPath(entry.docId),
        normalized,
        this.fs,
      );
      await writePrivateJson(this.path, [...entries, entry], this.fs);
      return entry;
    });
  }

  /** Update recency and optionally accumulate usage from retrieval and generation. */
  touch(
    docId: string,
    usage: Partial<RegistryUsage> = {},
  ): Promise<RegistryEntry> {
    return this.exclusive(async () => {
      this.documentPath(docId);
      const delta = RegistryUsage.safeParse({ ...EMPTY_USAGE, ...usage });
      if (!delta.success) throw storageError('Invalid document usage.');
      const entries = await this.readEntries();
      const entry = entries.find((item) => item.docId === docId);
      if (!entry) throw new AppError('DOC_NOT_FOUND');
      entry.lastUsedAt = this.timestamp();
      for (const field of Object.keys(EMPTY_USAGE) as (keyof RegistryUsage)[]) {
        entry.usage[field] += delta.data[field];
      }
      if (!RegistryEntry.safeParse(entry).success)
        throw storageError('Invalid accumulated document usage.');
      await writePrivateJson(this.path, entries, this.fs);
      return entry;
    });
  }

  /** Remove document and answers; callers also delete the matching backend namespace. */
  remove(docId: string): Promise<void> {
    return this.exclusive(async () => {
      const path = this.documentPath(docId);
      const entries = await this.readEntries();
      // Both explicit removal and LRU eviction pass here. Do not publish a removal when
      // private answers could not be deleted; callers can retry the operation.
      await this.answerCache.evictDocument(docId);
      await writePrivateJson(
        this.path,
        entries.filter((entry) => entry.docId !== docId),
        this.fs,
      );
      try {
        await this.fs.unlink(path);
      } catch (error) {
        if (!isMissingFile(error))
          throw storageError('The cached document could not be removed.');
      }
    });
  }

  /**
   * Resolve a label or a docId prefix. Hex input of six or more characters that matches a docId is
   * a prefix; if it also equals a different entry's label we refuse to guess.
   */
  findByLabelOrPrefix(query: string): Promise<RegistryEntry> {
    return this.exclusive(async () => {
      const parsed = z.string().trim().min(1).max(80).safeParse(query);
      if (!parsed.success)
        throw storageError(
          'Enter a document label or a document id prefix of at least six characters.',
        );
      const entries = await this.readEntries();
      const label = entries.find((entry) => entry.label === parsed.data);
      const hex = parsed.data.toLowerCase();
      const prefixMatches = /^[a-f0-9]{6,64}$/.test(hex)
        ? entries.filter((entry) => entry.docId.startsWith(hex))
        : [];
      if (label && prefixMatches.some((entry) => entry !== label)) {
        const ids = prefixMatches
          .map((entry) => `${entry.docId.slice(0, 12)} (${entry.label})`)
          .join(', ');
        throw storageError(
          `"${parsed.data}" is both a document label (${label.label}) and a document id prefix (${ids}). Use the full document id to choose.`,
        );
      }
      if (label) return label;
      if (prefixMatches.length > 1)
        throw storageError(
          'That document id prefix is ambiguous. Use more characters or an exact label.',
        );
      const match = prefixMatches[0];
      if (!match) throw new AppError('DOC_NOT_FOUND');
      return match;
    });
  }

  /** The oldest entries beyond the cap. The caller evicts these from their recorded backends. */
  evictionCandidates(maxDocs: number): Promise<RegistryEntry[]> {
    return this.exclusive(async () => {
      if (!z.number().int().nonnegative().safeParse(maxDocs).success) {
        throw storageError('The document cap must be a nonnegative integer.');
      }
      const entries = await this.readEntries();
      return entries
        .sort(
          (a, b) =>
            a.lastUsedAt.localeCompare(b.lastUsedAt) ||
            a.ingestedAt.localeCompare(b.ingestedAt) ||
            a.docId.localeCompare(b.docId),
        )
        .slice(0, Math.max(0, entries.length - maxDocs));
    });
  }

  /** Return the complete section tree, including amendment spans, for citations and excerpts. */
  getDocument(docId: string): Promise<NormalizedDoc> {
    return this.exclusive(async () => {
      const path = this.documentPath(docId);
      const entries = await this.readEntries();
      if (!entries.some((entry) => entry.docId === docId))
        throw new AppError('DOC_NOT_FOUND');
      const value = await readPrivateJson(path, this.fs);
      if (value === undefined) throw new AppError('DOC_NOT_FOUND');
      const parsed = NormalizedDoc.safeParse(value);
      if (!parsed.success || parsed.data.docId !== docId)
        throw storageError('The cached normalized document is invalid.');
      return parsed.data;
    });
  }
}
