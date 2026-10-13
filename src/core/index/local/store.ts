import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { AppError, Chunk } from '../../model/index.js';
import { Bm25Index, type Bm25Index as SparseIndex } from './bm25.js';

const Identity = z.object({
  id: z.string().min(1),
  revision: z.string().min(1),
});
export const StoreMeta = z.object({
  version: z.literal(1),
  embedding: Identity,
  reranker: Identity,
  dims: z.number().int().positive(),
  count: z.number().int().nonnegative(),
  hashes: z.object({ chunks: z.string(), dense: z.string(), bm25: z.string() }),
});
export type StoreMeta = z.infer<typeof StoreMeta>;
export interface Snapshot {
  chunks: Chunk[];
  vectors: Float32Array[];
  bm25: SparseIndex;
  meta: StoreMeta;
}

const digest = (bytes: string | Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');
const isMissing = (error: unknown): boolean =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT';

// All adapters pointing at the same namespace share a queue, including readers.
// This keeps chunk rows and vector rows together during a directory replacement.
const queues = new Map<string, Promise<unknown>>();

export class FileStore {
  readonly root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }

  private directory(docId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(docId)) {
      throw new AppError(
        'INVALID_INPUT',
        'Document id must be a safe path component.',
      );
    }
    return join(this.root, docId);
  }

  async run<T>(docId: string, operation: () => Promise<T>): Promise<T> {
    const directory = this.directory(docId);
    const previous = queues.get(directory) ?? Promise.resolve();
    const pending = previous
      .catch(() => undefined)
      .then(async () => {
        // Recover an interrupted replacement before accessing any of its files.
        const backup = `${directory}.previous`;
        try {
          await fs.access(directory);
        } catch (error) {
          if (!isMissing(error)) throw error;
          try {
            await fs.rename(backup, directory);
          } catch (recoveryError) {
            if (!isMissing(recoveryError)) throw recoveryError;
          }
        }
        await fs.rm(backup, { recursive: true, force: true });
        return operation();
      });
    queues.set(directory, pending);
    try {
      return await pending;
    } catch (cause) {
      if (
        cause instanceof AppError ||
        (cause instanceof Error && cause.name === 'AbortError')
      )
        throw cause;
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Could not access the local document store.',
        { cause },
      );
    } finally {
      if (queues.get(directory) === pending) queues.delete(directory);
    }
  }

  async has(docId: string): Promise<boolean> {
    try {
      await fs.access(join(this.directory(docId), 'meta.json'));
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  async load(docId: string): Promise<Snapshot | undefined> {
    if (!(await this.has(docId))) return undefined;
    const directory = this.directory(docId);
    const meta = StoreMeta.parse(
      JSON.parse(await fs.readFile(join(directory, 'meta.json'), 'utf8')),
    );
    const chunksBytes = await fs.readFile(
      join(directory, 'chunks.jsonl'),
      'utf8',
    );
    const dense = await fs.readFile(join(directory, 'dense.f32'));
    const sparseBytes = await fs.readFile(join(directory, 'bm25.json'), 'utf8');
    if (
      digest(chunksBytes) !== meta.hashes.chunks ||
      digest(dense) !== meta.hashes.dense ||
      digest(sparseBytes) !== meta.hashes.bm25
    ) {
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Local index files do not match their completion marker.',
      );
    }
    const chunks = chunksBytes.trim()
      ? chunksBytes
          .trim()
          .split('\n')
          .map((line) => Chunk.parse(JSON.parse(line)))
      : [];
    const bm25 = Bm25Index.parse(JSON.parse(sparseBytes));
    if (
      chunks.length !== meta.count ||
      dense.length !== meta.count * meta.dims * 4 ||
      bm25.lengths.length !== meta.count ||
      bm25.termFrequency.length !== meta.count ||
      chunks.some((chunk) => chunk.docId !== docId) ||
      new Set(chunks.map((chunk) => chunk.id)).size !== chunks.length
    ) {
      throw new AppError(
        'BACKEND_UNAVAILABLE',
        'Local index row counts or namespaces do not match.',
      );
    }
    const vectors = chunks.map((_chunk, row) => {
      const vector = new Float32Array(meta.dims);
      for (let dim = 0; dim < meta.dims; dim++)
        vector[dim] = dense.readFloatLE((row * meta.dims + dim) * 4);
      if (vector.some((value) => !Number.isFinite(value)))
        throw new AppError('BACKEND_UNAVAILABLE', 'Invalid stored embedding.');
      return vector;
    });
    return { chunks, vectors, bm25, meta };
  }

  async save(
    docId: string,
    snapshot: Omit<Snapshot, 'meta'> & { meta: Omit<StoreMeta, 'hashes'> },
  ): Promise<void> {
    const directory = this.directory(docId);
    const backup = `${directory}.previous`;
    const temporary = `${directory}.${randomUUID()}.tmp`;
    await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
    let backedUp = false;
    try {
      const chunks = snapshot.chunks
        .map((chunk) => JSON.stringify(chunk) + '\n')
        .join('');
      const dense = Buffer.alloc(snapshot.meta.count * snapshot.meta.dims * 4);
      snapshot.vectors.forEach((vector, row) => {
        vector.forEach((value, dim) =>
          dense.writeFloatLE(value, (row * snapshot.meta.dims + dim) * 4),
        );
      });
      const bm25 = JSON.stringify(snapshot.bm25);
      const meta: StoreMeta = {
        ...snapshot.meta,
        hashes: {
          chunks: digest(chunks),
          dense: digest(dense),
          bm25: digest(bm25),
        },
      };
      // Stage a complete generation; publish the completion marker last.
      for (const [name, bytes] of [
        ['chunks.jsonl', chunks],
        ['dense.f32', dense],
        ['bm25.json', bm25],
        ['meta.json', JSON.stringify(meta)],
      ] as const) {
        await fs.writeFile(join(temporary, `${name}.tmp`), bytes, {
          mode: 0o600,
        });
        await fs.rename(join(temporary, `${name}.tmp`), join(temporary, name));
      }
      try {
        await fs.rename(directory, backup);
        backedUp = true;
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      try {
        await fs.rename(temporary, directory);
      } catch (error) {
        if (backedUp) await fs.rename(backup, directory);
        throw error;
      }
      await fs.rm(backup, { recursive: true, force: true });
    } finally {
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }

  async delete(docId: string): Promise<void> {
    await fs.rm(this.directory(docId), { recursive: true, force: true });
  }
}
