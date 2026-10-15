import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND, envVar } from '../brand.js';
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
/** Total size of fetched bytes kept on disk before the least recently used are evicted. */
export const DEFAULT_CACHE_BUDGET_BYTES = 500 * 1024 * 1024;

/**
 * The cache size budget in bytes: `<PREFIX>_CACHE_MAX_MB` (whole megabytes) or the default.
 * A bad value is an error rather than a silent default, so a typo cannot quietly leave the
 * cache unbounded or tiny.
 */
export function cacheBudgetBytes(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const name = envVar('CACHE_MAX_MB');
  const raw = env[name]?.trim();
  if (!raw) return DEFAULT_CACHE_BUDGET_BYTES;
  const megabytes = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(megabytes) || megabytes < 1) {
    throw new AppError(
      'INVALID_INPUT',
      `${name} must be a whole number of megabytes.`,
      {
        userMessage: `${name} must be a whole number of megabytes, at least 1.`,
      },
    );
  }
  return megabytes * 1024 * 1024;
}

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
    // Recency drives eviction: a hit makes this snapshot the last to go.
    const now = new Date();
    await utimes(path, now, now).catch(() => undefined);
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
  await updateIndex(cacheDir, (index) => ({
    ...index,
    [validated.url]: docId,
  }));
  return docId;
}

/**
 * Serialize read-modify-write within this process so concurrent downloads retain every URL.
 * `change` returns the new index, or undefined when nothing changed, which skips the write
 * (and so a missing directory).
 */
async function updateIndex(
  cacheDir: string,
  change: (index: Record<string, string>) => Record<string, string> | undefined,
): Promise<void> {
  const previous = indexUpdates.get(cacheDir) ?? Promise.resolve();
  const update = previous
    .catch(() => undefined)
    .then(async () => {
      const next = change(await readIndex(cacheDir));
      if (next)
        await atomicWrite(join(cacheDir, 'index.json'), JSON.stringify(next));
    });
  indexUpdates.set(cacheDir, update);
  try {
    await update;
  } finally {
    if (indexUpdates.get(cacheDir) === update) indexUpdates.delete(cacheDir);
  }
}

async function removeFiles(cacheDir: string, docId: string): Promise<void> {
  await rm(join(cacheDir, docId), { force: true });
  await rm(join(cacheDir, `${docId}.json`), { force: true });
}

/**
 * Delete the cached bytes of documents and every URL that points at them. Only the index entries
 * that resolve to a removed snapshot go: a URL that has since been fetched again (so it points at
 * a newer snapshot another document still uses) keeps its entry and its bytes.
 */
export async function removeCached(
  docIds: readonly string[],
  cacheDir: string,
): Promise<void> {
  const ids = new Set(docIds.filter((id) => SHA256.test(id)));
  if (ids.size === 0) return;
  // Index first: a URL must never point at bytes that are already gone.
  await updateIndex(cacheDir, (index) => {
    const kept = Object.entries(index).filter(([, docId]) => !ids.has(docId));
    return kept.length === Object.keys(index).length
      ? undefined
      : Object.fromEntries(kept);
  });
  for (const docId of ids) await removeFiles(cacheDir, docId);
}

interface CachedFile {
  docId: string;
  size: number;
  usedAtMs: number;
}

async function listCached(cacheDir: string): Promise<CachedFile[]> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch (error) {
    if (isCacheMiss(error)) return [];
    throw error;
  }
  const files: CachedFile[] = [];
  for (const name of names) {
    if (!SHA256.test(name)) continue;
    try {
      const blob = await stat(join(cacheDir, name));
      const sidecar = await stat(join(cacheDir, `${name}.json`)).catch(
        () => undefined,
      );
      files.push({
        docId: name,
        size: blob.size + (sidecar?.size ?? 0),
        usedAtMs: blob.mtimeMs,
      });
    } catch (error) {
      if (!isCacheMiss(error)) throw error;
    }
  }
  return files;
}

/**
 * Evict least recently used snapshots until the cache fits `budgetBytes`. `keep` is never
 * evicted, so the snapshot just written survives even a budget smaller than itself.
 * Returns the evicted ids.
 */
export async function evictToBudget(
  cacheDir: string,
  budgetBytes: number,
  keep?: string,
): Promise<string[]> {
  const files = await listCached(cacheDir);
  let total = files.reduce((sum, file) => sum + file.size, 0);
  if (total <= budgetBytes) return [];
  const victims: string[] = [];
  const oldestFirst = files
    .filter((file) => file.docId !== keep)
    .sort((a, b) => a.usedAtMs - b.usedAtMs || a.docId.localeCompare(b.docId));
  for (const file of oldestFirst) {
    if (total <= budgetBytes) break;
    victims.push(file.docId);
    total -= file.size;
  }
  await removeCached(victims, cacheDir);
  return victims;
}

/**
 * Delete every fetched snapshot, its sidecar and the URL index. Anything else under the cache
 * directory (the answer cache) is left alone: it is cleared with its document. Returns what
 * was freed.
 */
export async function clearCache(
  cacheDir: string,
): Promise<{ snapshots: number; bytes: number }> {
  const files = await listCached(cacheDir);
  // Index first: a URL must never point at bytes that are already gone.
  await rm(join(cacheDir, 'index.json'), { force: true });
  for (const file of files) await removeFiles(cacheDir, file.docId);
  return {
    snapshots: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}
