import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND } from '../brand.js';
import { AppError } from '../model/index.js';

const CacheMetadata = z.object({
  url: z.url(),
  finalUrl: z.url(),
  contentType: z.string(),
  fetchedAt: z.iso.datetime(),
});
const SHA256 = /^[a-f0-9]{64}$/;
const CacheIndex = z.record(z.url(), z.string().regex(SHA256));
const indexUpdates = new Map<string, Promise<void>>();
export type CacheMetadata = z.infer<typeof CacheMetadata>;
export interface CachedDocument extends CacheMetadata {
  docId: string;
  bytes: Uint8Array;
}
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export function defaultCacheDir(
  configDir = join(homedir(), BRAND.configDirName),
): string {
  return join(configDir, 'cache');
}
export function documentId(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isCacheMiss(error: unknown): boolean {
  return (
    error instanceof SyntaxError ||
    (error instanceof Error && 'code' in error && error.code === 'ENOENT')
  );
}

async function readIndex(cacheDir: string): Promise<Record<string, string>> {
  try {
    const parsed = CacheIndex.safeParse(
      JSON.parse(
        await readFile(join(cacheDir, 'index.json'), 'utf8'),
      ) as unknown,
    );
    return parsed.success ? parsed.data : {};
  } catch (error) {
    if (isCacheMiss(error)) return {};
    throw error;
  }
}

/** Entries never expire in the RC; URL lookups use the index, docIds go directly to disk. */
export async function readCache(
  urlOrDocId: string,
  cacheDir: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<CachedDocument | undefined> {
  const docId = SHA256.test(urlOrDocId)
    ? urlOrDocId
    : (await readIndex(cacheDir))[urlOrDocId];
  if (!docId) return undefined;
  try {
    const metadata = CacheMetadata.safeParse(
      JSON.parse(
        await readFile(join(cacheDir, `${docId}.json`), 'utf8'),
      ) as unknown,
    );
    if (!metadata.success) return undefined;
    const path = join(cacheDir, docId);
    if ((await stat(path)).size > maxBytes) throw new AppError('TOO_LARGE');
    const bytes = await readFile(path);
    if (bytes.length > maxBytes) throw new AppError('TOO_LARGE');
    if (documentId(bytes) !== docId) return undefined;
    return { ...metadata.data, docId, bytes };
  } catch (error) {
    if (isCacheMiss(error)) return undefined;
    throw error;
  }
}

async function atomicWrite(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, data, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function writeCache(
  bytes: Uint8Array,
  metadata: CacheMetadata,
  cacheDir: string,
): Promise<string> {
  const validated = CacheMetadata.parse(metadata);
  const docId = documentId(bytes);
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  await atomicWrite(join(cacheDir, docId), bytes);
  await atomicWrite(join(cacheDir, `${docId}.json`), JSON.stringify(validated));
  // Serialize read-modify-write within this process so concurrent downloads retain every URL.
  const previous = indexUpdates.get(cacheDir) ?? Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(async () => {
      const index = await readIndex(cacheDir);
      index[validated.url] = docId;
      await atomicWrite(join(cacheDir, 'index.json'), JSON.stringify(index));
    });
  indexUpdates.set(cacheDir, update);
  try {
    await update;
  } finally {
    if (indexUpdates.get(cacheDir) === update) indexUpdates.delete(cacheDir);
  }
  return docId;
}
