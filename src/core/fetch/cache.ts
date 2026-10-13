import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
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

/** URL lookup uses sidecars; the content hash remains the only raw-byte filename. */
export async function readCache(
  url: string,
  cacheDir: string,
  maxBytes = DEFAULT_MAX_BYTES,
): Promise<CachedDocument | undefined> {
  let files: string[];
  try {
    files = await readdir(cacheDir);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  }
  for (const file of files.sort()) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    try {
      const metadata = CacheMetadata.safeParse(
        JSON.parse(await readFile(join(cacheDir, file), 'utf8')) as unknown,
      );
      if (!metadata.success || metadata.data.url !== url) continue;
      const docId = file.slice(0, -5);
      const path = join(cacheDir, docId);
      if ((await stat(path)).size > maxBytes) throw new AppError('TOO_LARGE');
      const bytes = await readFile(path);
      if (bytes.length > maxBytes) throw new AppError('TOO_LARGE');
      if (documentId(bytes) !== docId) continue;
      return { ...metadata.data, docId, bytes };
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        continue;
      throw error;
    }
  }
  return undefined;
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
  return docId;
}
