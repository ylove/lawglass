/**
 * Per-reader document lists for hosted modes.
 *
 * Everyone with the invite link shares one document store, but each browser keeps its own list
 * of the documents it added or opened. A reader is a random 128-bit id in a cookie. The id is an
 * unguessable list key, not an authorization boundary: any invitee may open any document in the
 * store by its id (invitees share `/doc/<id>` links on purpose).
 *
 * The raw id never reaches the filesystem. Lists live at `<configDir>/readers/<sha256(id)>.json`,
 * so a crafted cookie cannot name another reader's file or walk out of the directory, and a
 * leaked snapshot does not hold the cookie values themselves.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND } from '../core/brand.js';
import {
  configFileSystem,
  isMissingFile,
  readPrivateJson,
  writePrivateJson,
  type ConfigFileSystem,
} from '../core/config-files.js';
import { NormalizedDoc } from '../core/model/index.js';

export const READER_COOKIE = `${BRAND.name}_reader`;
export const READER_COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;

/** 16 random bytes in base64url are exactly 22 characters from this alphabet. */
const READER_ID_FORMAT = /^[A-Za-z0-9_-]{22}$/;

export function newReaderId(): string {
  return randomBytes(16).toString('base64url');
}

/** True only for ids this module could have issued; anything else gets a fresh id. */
export function isReaderId(value: string | undefined): value is string {
  return value !== undefined && READER_ID_FORMAT.test(value);
}

/** The filename stem for a reader. A one-way hash, so the cookie never names a path. */
export function readerKey(readerId: string): string {
  return createHash('sha256').update(readerId).digest('hex');
}

const ReaderDoc = z
  .object({
    docId: NormalizedDoc.shape.docId,
    addedAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime(),
  })
  .strict();
export type ReaderDoc = z.infer<typeof ReaderDoc>;
const ReaderFile = z.object({ docs: z.array(ReaderDoc) }).strict();

export interface ReaderLibraryOptions {
  fs?: ConfigFileSystem;
  now?: () => Date;
}

// The server process is the only writer of these files, so an in-process queue per file is
// enough to keep read-modify-write cycles from interleaving (the registry also needs a
// cross-process lock because the CLI writes it too).
const queues = new Map<string, Promise<unknown>>();

export class ReaderLibrary {
  private readonly dir: string;
  private readonly fs: ConfigFileSystem;
  private readonly now: () => Date;

  constructor(configDir: string, options: ReaderLibraryOptions = {}) {
    this.dir = join(configDir, 'readers');
    this.fs = options.fs ?? configFileSystem;
    this.now = options.now ?? (() => new Date());
  }

  private pathFor(readerId: string): string {
    if (!isReaderId(readerId)) throw new Error('Invalid reader id.');
    return join(this.dir, `${readerKey(readerId)}.json`);
  }

  private serialized<T>(path: string, work: () => Promise<T>): Promise<T> {
    const next = (queues.get(path) ?? Promise.resolve())
      .catch(() => undefined)
      .then(work);
    queues.set(path, next);
    return next.finally(() => {
      if (queues.get(path) === next) queues.delete(path);
    });
  }

  private async read(path: string): Promise<ReaderDoc[]> {
    const parsed = ReaderFile.safeParse(
      (await readPrivateJson(path, this.fs)) ?? { docs: [] },
    );
    // A damaged list is only a convenience; start over rather than lock the reader out.
    return parsed.success ? parsed.data.docs : [];
  }

  /** The reader's documents, most recently used first. May name documents that were evicted. */
  async list(readerId: string): Promise<ReaderDoc[]> {
    const path = this.pathFor(readerId);
    return await this.serialized(path, async () =>
      (await this.read(path)).sort((a, b) =>
        b.lastUsedAt.localeCompare(a.lastUsedAt),
      ),
    );
  }

  /** Add the document, or mark it used now when it is already listed. */
  async markUsed(readerId: string, docId: string): Promise<void> {
    const path = this.pathFor(readerId);
    await this.serialized(path, async () => {
      const docs = await this.read(path);
      const at = this.now().toISOString();
      const existing = docs.find((d) => d.docId === docId);
      if (existing) existing.lastUsedAt = at;
      else docs.push({ docId, addedAt: at, lastUsedAt: at });
      await writePrivateJson(path, { docs }, this.fs);
    });
  }

  /** Take the document off this reader's list only. Unknown documents are a no-op. */
  async remove(readerId: string, docId: string): Promise<void> {
    const path = this.pathFor(readerId);
    await this.serialized(path, async () => {
      const docs = await this.read(path);
      const rest = docs.filter((d) => d.docId !== docId);
      if (rest.length !== docs.length)
        await writePrivateJson(path, { docs: rest }, this.fs);
    });
  }

  /** Every document any reader lists. Eviction spares these while it can. */
  async listedDocIds(): Promise<Set<string>> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      if (isMissingFile(error)) return new Set();
      throw error;
    }
    const listed = new Set<string>();
    for (const name of names) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const path = join(this.dir, name);
      for (const d of await this.serialized(path, () => this.read(path)))
        listed.add(d.docId);
    }
    return listed;
  }
}
